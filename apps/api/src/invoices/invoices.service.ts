import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';

import { AuthenticatedUser } from '../auth/auth.types';
import { TOTAL_MILLIMES } from '@org/shared';
import {
  assertSameBuilding,
  requireValidPeriod,
} from '../common/tenant';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { aggregateRun } from './run-invoices';
import {
  effectiveBuildingOwnershipWhere,
  effectiveOwnershipWhere,
  endOfBillingPeriod,
  isEffectiveOwnership,
  requireActiveBuildingId,
} from '../ownerships/ownership-scope';
import { RunInvoicesDto } from './dto/run-invoices.dto';

const INVOICE_WITH_UNIT = Prisma.validator<Prisma.InvoiceInclude>()({
  unit: { select: { label: true } },
});

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async run(
    buildingId: string,
    dto: RunInvoicesDto,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    const periodYearMonth = requireValidPeriod(dto.periodYearMonth);

    const building = await this.prisma.building.findUnique({
      where: { id: buildingId },
      include: { units: { orderBy: { label: 'asc' } } },
    });
    if (!building) {
      throw new BadRequestException('Building not found');
    }

    if (
      building.units.some(
        (unit) => !Number.isSafeInteger(unit.millimes) || unit.millimes <= 0,
      )
    ) {
      throw new BadRequestException('Every unit must have positive integer millimes');
    }
    const millimesTotal = building.units.reduce(
      (sum, unit) => sum + unit.millimes,
      0,
    );
    if (millimesTotal !== TOTAL_MILLIMES) {
      throw new BadRequestException(
        `millimes must total ${TOTAL_MILLIMES} but units sum to ${millimesTotal}`,
      );
    }

    const expenses = await this.prisma.expense.findMany({
      where: { buildingId, periodYearMonth },
      select: {
        id: true,
        totalCents: true,
        shares: { select: { unitId: true, amountCents: true } },
      },
    });
    if (expenses.length === 0) {
      throw new BadRequestException('no expenses for period');
    }

    const unitIds = new Set(building.units.map((unit) => unit.id));
    for (const expense of expenses) {
      let shareTotal = 0;
      for (const share of expense.shares) {
        if (!unitIds.has(share.unitId)) {
          throw new BadRequestException(
            `Expense ${expense.id ?? ''} contains a share for a unit outside the building`,
          );
        }
        if (!Number.isSafeInteger(share.amountCents) || share.amountCents < 0) {
          throw new BadRequestException('Expense shares must be non-negative integers');
        }
        shareTotal += share.amountCents;
      }
      if (
        typeof expense.totalCents === 'number' &&
        shareTotal !== expense.totalCents
      ) {
        throw new BadRequestException(
          `Expense ${expense.id ?? ''} shares do not add up to its total`,
        );
      }
    }

    const totals = new Map(
      aggregateRun(expenses).map((entry) => [entry.unitId, entry.totalCents]),
    );

    // An invoice is an issued financial document.  Once any invoice exists
    // for this building/period, compare the complete expected document set
    // before touching Prisma.  This makes a same-input rerun a true no-op and
    // rejects a changed issued/paid period instead of silently repricing it.
    const existing = await this.prisma.invoice.findMany({
      where: { buildingId, periodYearMonth },
      select: {
        id: true,
        unitId: true,
        totalCents: true,
        paidCents: true,
        status: true,
      },
    });
    if (existing.length > 0) {
      const existingByUnit = new Map(
        existing.map((invoice) => [invoice.unitId, invoice]),
      );
      const changes: string[] = [];
      for (const invoice of existing) {
        const expected = totals.get(invoice.unitId);
        if (!unitIds.has(invoice.unitId)) {
          changes.push(`unexpected unit ${invoice.unitId}`);
        } else if (expected === undefined || invoice.totalCents !== expected) {
          changes.push(
            `unit ${invoice.unitId} (${invoice.totalCents} → ${expected ?? 0})`,
          );
        }
        if (invoice.paidCents < 0 || invoice.paidCents > invoice.totalCents) {
          changes.push(`unit ${invoice.unitId} has an inconsistent paid amount`);
        }
      }
      for (const unit of building.units) {
        const expected = totals.get(unit.id) ?? 0;
        if (!existingByUnit.has(unit.id)) {
          changes.push(`new unit ${unit.id} (${expected})`);
        }
      }
      if (changes.length > 0) {
        throw new BadRequestException(
          `Invoices for ${periodYearMonth} were already issued and are immutable; no repricing was performed: ${changes.join(', ')}`,
        );
      }
      return this.listForPeriod(buildingId, periodYearMonth);
    }

    const paidByUnitId = new Map(
      existing.map((invoice) => [invoice.unitId, invoice.paidCents]),
    );
    // The period is not issued yet.  Use an empty update in the upsert so a
    // concurrent rerun can never overwrite a total/status that appeared after
    // the preflight read.
    await this.prisma.$transaction(
      building.units.map((unit) => {
        const totalCents = totals.get(unit.id) ?? 0;
        const paidCents = paidByUnitId.get(unit.id) ?? 0;
        const status =
          totalCents > 0 && paidCents >= totalCents
            ? PaymentStatus.PAID
            : PaymentStatus.PENDING;
        return this.prisma.invoice.upsert({
          where: {
            unitId_periodYearMonth: { unitId: unit.id, periodYearMonth },
          },
          create: {
            buildingId,
            unitId: unit.id,
            periodYearMonth,
            totalCents,
            paidCents,
            status,
          },
          update: {},
        });
      }),
    );

    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'invoice.run',
      entity: 'invoice',
      entityId: periodYearMonth,
      metadata: { units: building.units.length, immutable: true },
    });

    void this.notifyOwners(buildingId, periodYearMonth);

    return this.listForPeriod(buildingId, periodYearMonth);
  }

  private async notifyOwners(
    buildingId: string,
    periodYearMonth: string,
  ): Promise<void> {
    const at = endOfBillingPeriod(periodYearMonth);
    const owners = await this.prisma.ownership.findMany({
      where: effectiveBuildingOwnershipWhere(buildingId, at),
      distinct: ['userId'],
    });
    const effectiveOwners = owners.filter((owner) =>
      isEffectiveOwnership(owner, at),
    );
    await this.notifications.createForUsers(
      effectiveOwners.map((owner) => owner.userId),
      {
        type: 'invoice.issued',
        title: 'Νέο κοινοχρήστους λόγος',
        linkPath: '/balance',
        sms: { kind: 'invoice.issued', periodKey: periodYearMonth },
      },
    );
  }

  async listAdmin(
    buildingId: string,
    periodYearMonth: string | undefined,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);

    return this.prisma.invoice.findMany({
      where: {
        buildingId,
        ...(periodYearMonth ? { periodYearMonth } : {}),
      },
      include: INVOICE_WITH_UNIT,
      orderBy: [{ periodYearMonth: 'desc' }, { unit: { label: 'asc' } }],
    });
  }

  async findMine(
    periodYearMonth: string | undefined,
    user: AuthenticatedUser,
  ) {
    const buildingId = requireActiveBuildingId(user);
    const period =
      periodYearMonth === undefined
        ? undefined
        : requireValidPeriod(periodYearMonth);
    const at = period ? endOfBillingPeriod(period) : new Date();
    const ownerships = await this.prisma.ownership.findMany({
      where: effectiveOwnershipWhere(user.id, buildingId, at),
    });
    const unitIds = [
      ...new Set(
        ownerships
          .filter((ownership) => isEffectiveOwnership(ownership, at))
          .map((ownership) => ownership.unitId),
      ),
    ];
    if (unitIds.length === 0) {
      throw new ForbiddenException('User has no effective ownership in the active building');
    }

    return this.prisma.invoice.findMany({
      where: {
        buildingId,
        unitId: { in: unitIds },
        ...(period ? { periodYearMonth: period } : {}),
      },
      include: INVOICE_WITH_UNIT,
      orderBy: { periodYearMonth: 'desc' },
    });
  }

  private listForPeriod(buildingId: string, periodYearMonth: string) {
    return this.prisma.invoice.findMany({
      where: { buildingId, periodYearMonth },
      include: INVOICE_WITH_UNIT,
      orderBy: { unit: { label: 'asc' } },
    });
  }
}
