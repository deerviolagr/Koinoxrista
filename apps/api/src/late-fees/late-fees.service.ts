import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  LateFeeChargeDto,
  LateFeeRunResultDto,
  LateFeeSettingsDto,
} from '@org/shared';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { assertSameBuilding, requireValidPeriod } from '../common/tenant';
import { PrismaService } from '../prisma/prisma.service';
import {
  computeLateFee,
  dueMomentForPeriod,
  wholeDaysBetween,
  type LateFeeCalcSettings,
  type LateFeeMode,
} from './late-fee-calc';
import { RunLateFeesDto } from './dto/run-late-fees.dto';
import { UpdateLateFeeSettingsDto } from './dto/update-late-fee-settings.dto';

/** Applied when a building has no LateFeeSetting row yet. */
const DEFAULT_SETTINGS = {
  graceDays: 5,
  mode: 'FLAT' as LateFeeMode,
  dailyFlatCents: 0,
  dailyBps: 0,
  capCents: null as number | null,
};

type SettingsRow = Omit<typeof DEFAULT_SETTINGS, 'mode'> & {
  mode: string;
  updatedAt?: Date;
};

@Injectable()
export class LateFeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Current settings; built-in defaults when never configured. */
  async getSettings(
    buildingId: string,
    user: AuthenticatedUser,
  ): Promise<LateFeeSettingsDto> {
    assertSameBuilding(user, buildingId);
    const row = await this.prisma.lateFeeSetting.findUnique({
      where: { buildingId },
    });
    return this.toSettingsDto(buildingId, row ?? DEFAULT_SETTINGS);
  }

  async updateSettings(
    buildingId: string,
    dto: UpdateLateFeeSettingsDto,
    user: AuthenticatedUser,
  ): Promise<LateFeeSettingsDto> {
    assertSameBuilding(user, buildingId);

    const existing = await this.prisma.lateFeeSetting.findUnique({
      where: { buildingId },
    });
    const merged = {
      graceDays: dto.graceDays ?? existing?.graceDays ?? DEFAULT_SETTINGS.graceDays,
      mode: dto.mode ?? existing?.mode ?? DEFAULT_SETTINGS.mode,
      dailyFlatCents:
        dto.dailyFlatCents ?? existing?.dailyFlatCents ?? DEFAULT_SETTINGS.dailyFlatCents,
      dailyBps: dto.dailyBps ?? existing?.dailyBps ?? DEFAULT_SETTINGS.dailyBps,
      capCents:
        dto.capCents !== undefined ? dto.capCents : (existing?.capCents ?? null),
    };
    this.assertRateUsable(merged);

    const row = await this.prisma.lateFeeSetting.upsert({
      where: { buildingId },
      create: {
        buildingId,
        graceDays: merged.graceDays,
        mode: merged.mode,
        dailyFlatCents: merged.dailyFlatCents,
        dailyBps: merged.dailyBps,
        capCents: merged.capCents,
      },
      update: {
        graceDays: merged.graceDays,
        mode: merged.mode,
        dailyFlatCents: merged.dailyFlatCents,
        dailyBps: merged.dailyBps,
        capCents: merged.capCents,
      },
    });

    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'late-fee.settings.update',
      entity: 'late_fee_setting',
      entityId: buildingId,
      metadata: {
        graceDays: row.graceDays,
        mode: row.mode,
        dailyFlatCents: row.dailyFlatCents,
        dailyBps: row.dailyBps,
        capCents: row.capCents,
      },
    });

    return this.toSettingsDto(buildingId, row);
  }

  /**
   * Calculates late-fee candidates, but refuses to create active charges while
   * LateFeeCharge is disconnected from the Invoice/Payment receivables model.
   * Historical charges remain listable/waivable; a schema-backed settlement
   * path is required before this sweep can safely become active.
   */
  async run(
    buildingId: string,
    dto: RunLateFeesDto,
    user: AuthenticatedUser,
  ): Promise<LateFeeRunResultDto> {
    assertSameBuilding(user, buildingId);
    const month = dto.month ? requireValidPeriod(dto.month) : undefined;

    const settingsRow = await this.prisma.lateFeeSetting.findUnique({
      where: { buildingId },
    });
    const setting: LateFeeCalcSettings = settingsRow
      ? {
          mode: settingsRow.mode as LateFeeMode,
          dailyFlatCents: settingsRow.dailyFlatCents,
          dailyBps: settingsRow.dailyBps,
          capCents: settingsRow.capCents,
        }
      : DEFAULT_SETTINGS;
    const graceDays = settingsRow
      ? settingsRow.graceDays
      : DEFAULT_SETTINGS.graceDays;

    // Route through Date.now() so clocks are injectable/mockable in tests.
    const now = new Date(Date.now());
    const invoices = await this.prisma.invoice.findMany({
      where: {
        buildingId,
        status: { not: 'PAID' },
        ...(month ? { periodYearMonth: month } : {}),
      },
      include: { unit: { select: { label: true } } },
    });

    const existingCharges = await this.prisma.lateFeeCharge.findMany({
      where: { buildingId, ...(month ? { month } : {}) },
      select: { unitId: true, month: true },
    });
    const chargedKeys = new Set(
      existingCharges.map((charge) => `${charge.unitId}:${charge.month}`),
    );

    // A LateFeeCharge has no receivable/payment relation in the current data
    // model.  Creating one would therefore only make a number appear
    // "collectible" while ArrearsService, checkout, and the bank importer all
    // ignore it.  Calculate first, then fail closed before any write.  This is
    // intentional: a schema that can settle charges must integrate them into
    // Invoice/Payment (or add an equivalent receivables ledger) before active
    // charges are enabled.
    const pendingCharges: Array<{
      invoiceId: string;
      unitId: string;
      month: string;
      daysLate: number;
      amountCents: number;
    }> = [];
    for (const invoice of invoices) {
      const outstandingCents = invoice.totalCents - invoice.paidCents;
      if (outstandingCents <= 0) continue;

      const key = `${invoice.unitId}:${invoice.periodYearMonth}`;
      if (chargedKeys.has(key)) continue;

      // An invoice becomes due the instant its period month ends; grace days
      // are free of charge and only days beyond them accrue fees.
      const overdueDays = wholeDaysBetween(
        now,
        dueMomentForPeriod(invoice.periodYearMonth),
      );
      if (overdueDays <= graceDays) continue;
      const chargeableDays = overdueDays - graceDays;

      const amountCents = computeLateFee({
        outstandingCents,
        daysLate: chargeableDays,
        setting,
      });
      if (amountCents <= 0) continue;
      pendingCharges.push({
        invoiceId: invoice.id,
        unitId: invoice.unitId,
        month: invoice.periodYearMonth,
        daysLate: chargeableDays,
        amountCents,
      });
    }

    if (pendingCharges.length > 0) {
      throw new ConflictException(
        `Late fees are disabled: ${pendingCharges.length} charge(s) cannot be settled by the current Invoice/Payment receivables model; no charges were created`,
      );
    }

    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'late-fee.run',
      entity: 'late_fee_charge',
      entityId: month ?? buildingId,
      metadata: {
        charged: 0,
        totalCents: 0,
        ...(month ? { month } : {}),
      },
    });

    return { charged: 0, totalCents: 0 };
  }

  /** Charges with unit labels, newest first. */
  async list(
    buildingId: string,
    user: AuthenticatedUser,
  ): Promise<LateFeeChargeDto[]> {
    assertSameBuilding(user, buildingId);

    const charges = await this.prisma.lateFeeCharge.findMany({
      where: { buildingId },
      include: { unit: { select: { label: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return charges.map((charge) => this.toChargeDto(charge));
  }

  /** Waives a charge (idempotent); waived charges stay listed but inert. */
  async waive(id: string, user: AuthenticatedUser): Promise<LateFeeChargeDto> {
    const charge = await this.prisma.lateFeeCharge.findFirst({
      where: { id },
      include: { unit: { select: { label: true } } },
    });
    if (!charge) throw new NotFoundException('Late fee charge not found');
    assertSameBuilding(user, charge.buildingId);

    if (!charge.waivedAt) {
      const waivedAt = new Date();
      await this.prisma.lateFeeCharge.update({
        where: { id: charge.id },
        data: { waivedAt },
      });
      this.audit.record({
        buildingId: charge.buildingId,
        actorId: user.id,
        actorRole: user.role,
        action: 'late-fee.waive',
        entity: 'late_fee_charge',
        entityId: charge.id,
        metadata: {
          unitId: charge.unitId,
          month: charge.month,
          amountCents: charge.amountCents,
        },
      });
      return this.toChargeDto({ ...charge, waivedAt });
    }

    return this.toChargeDto(charge);
  }

  private toChargeDto(charge: {
    id: string;
    buildingId: string;
    unitId: string;
    invoiceId: string;
    month: string;
    daysLate: number;
    amountCents: number;
    waivedAt: Date | null;
    createdAt: Date;
    unit?: { label: string } | null;
  }): LateFeeChargeDto {
    return {
      id: charge.id,
      buildingId: charge.buildingId,
      unitId: charge.unitId,
      invoiceId: charge.invoiceId,
      month: charge.month,
      daysLate: charge.daysLate,
      amountCents: charge.amountCents,
      waivedAt: charge.waivedAt ? charge.waivedAt.toISOString() : null,
      unitLabel: charge.unit?.label ?? null,
      createdAt: charge.createdAt.toISOString(),
    };
  }

  private assertRateUsable(setting: {
    mode: string;
    dailyFlatCents: number;
    dailyBps: number;
  }): void {
    if (setting.mode === 'FLAT' && setting.dailyFlatCents <= 0) {
      throw new BadRequestException('dailyFlatCents must be positive in FLAT mode');
    }
    if (setting.mode === 'PERCENT' && setting.dailyBps <= 0) {
      throw new BadRequestException('dailyBps must be positive in PERCENT mode');
    }
  }

  private toSettingsDto(
    buildingId: string,
    row: SettingsRow,
  ): LateFeeSettingsDto {
    return {
      buildingId,
      graceDays: row.graceDays,
      mode: row.mode as LateFeeMode,
      dailyFlatCents: row.dailyFlatCents,
      dailyBps: row.dailyBps,
      capCents: row.capCents,
      ...(row.updatedAt ? { updatedAt: row.updatedAt.toISOString() } : {}),
    };
  }
}
