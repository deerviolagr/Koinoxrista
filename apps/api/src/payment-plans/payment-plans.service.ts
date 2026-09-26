import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import type { PaymentPlan, PaymentPlanInstallment } from '@prisma/client';
import type {
  CreatePaymentPlanDto,
  InstallmentDto,
  PaymentPlanDto,
  PaymentPlanStatus,
} from '@org/shared';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { assertSameBuilding } from '../common/tenant';
import { PrismaService } from '../prisma/prisma.service';
import {
  effectiveOwnershipWhere,
  isEffectiveOwnership,
  requireActiveBuildingId,
} from '../ownerships/ownership-scope';
import { RecordPlanPaymentDto } from './dto/record-plan-payment.dto';
import {
  applyPaymentToPlan,
  installmentRemaining,
  splitIntoInstallments,
} from './payment-plan-calc';
import { allocatePlanPaymentToInvoices } from './payment-plan-settlement';
import type { PlanInvoiceAllocation } from './payment-plan-settlement';

const PLAN_STATUSES: PaymentPlanStatus[] = ['ACTIVE', 'COMPLETED', 'CANCELLED'];
const PLAN_PAYMENT_PREFIX = 'payment-plan';

/** Plan rows with their schedule and the unit label for listings. */
const PLAN_WITH_SCHEDULE = {
  include: {
    unit: { select: { label: true } },
    installments: { orderBy: { seq: 'asc' as const } },
  },
};

type PlanWithSchedule = PaymentPlan & {
  installments: PaymentPlanInstallment[];
  unit?: { label: string } | null;
};

@Injectable()
export class PaymentPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Splits a unit's arrears into installments. Idempotent at most ONE ACTIVE
   * plan per unit: a second creation attempt while one is running is a 409.
   */
  async create(
    buildingId: string,
    dto: CreatePaymentPlanDto,
    user: AuthenticatedUser,
  ): Promise<PaymentPlanDto> {
    assertSameBuilding(user, buildingId);
    if (
      !Number.isSafeInteger(dto.installmentCount) ||
      dto.installmentCount < 2 ||
      dto.installmentCount > 24
    ) {
      throw new BadRequestException('installmentCount must be between 2 and 24');
    }
    const intervalDays = dto.intervalDays ?? 30;
    if (!Number.isSafeInteger(intervalDays) || intervalDays <= 0) {
      throw new BadRequestException('intervalDays must be a positive integer');
    }

    const unit = await this.prisma.unit.findFirst({
      where: { id: dto.unitId, buildingId },
      select: { id: true, label: true },
    });
    if (!unit) throw new NotFoundException('Unit not found');

    const active = await this.prisma.paymentPlan.findFirst({
      where: { unitId: unit.id, buildingId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (active) {
      throw new ConflictException('Unit already has an active payment plan');
    }

    const totalCents =
      dto.totalCents !== undefined
        ? dto.totalCents
        : await this.arrearsFor(buildingId, unit.id);
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
      throw new BadRequestException('totalCents must be a positive integer amount');
    }

    const firstDueDate = new Date(dto.firstDueDate);
    if (Number.isNaN(firstDueDate.getTime())) {
      throw new BadRequestException('firstDueDate must be a valid ISO date');
    }

    const schedule = splitIntoInstallments(
      totalCents,
      dto.installmentCount,
      firstDueDate,
      intervalDays,
    );
    const plan = await this.prisma.paymentPlan.create({
      data: {
        buildingId,
        unitId: unit.id,
        totalCents,
        installmentCount: dto.installmentCount,
        status: 'ACTIVE',
        installments: {
          create: schedule.map((installment) => ({
            seq: installment.seq,
            dueDate: installment.dueDate,
            amountCents: installment.amountCents,
          })),
        },
      },
      ...PLAN_WITH_SCHEDULE,
    });

    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'payment-plan.create',
      entity: 'payment_plan',
      entityId: plan.id,
      metadata: {
        unitId: unit.id,
        totalCents,
        installmentCount: dto.installmentCount,
        intervalDays,
        firstDueDate: firstDueDate.toISOString(),
      },
    });

    return this.toPlanDto(plan);
  }

  /** Plans of the building, newest first; optional status filter. */
  async list(
    buildingId: string,
    user: AuthenticatedUser,
    status?: string,
  ): Promise<PaymentPlanDto[]> {
    assertSameBuilding(user, buildingId);
    this.assertKnownStatus(status);

    const plans = await this.prisma.paymentPlan.findMany({
      where: { buildingId, ...(status ? { status } : {}) },
      ...PLAN_WITH_SCHEDULE,
      orderBy: { createdAt: 'desc' },
    });
    return plans.map((plan) => this.toPlanDto(plan));
  }

  /** Full schedule with running totals. */
  async get(id: string, user: AuthenticatedUser): Promise<PaymentPlanDto> {
    const plan = await this.findOwned(id, user);
    return this.toPlanDto(plan);
  }

  /**
   * Records a payment against an ACTIVE plan.  The same transaction creates a
   * real Payment row for each invoice allocation, advances invoice balances
   * oldest-first, and advances the installment schedule.  A stable optional
   * idempotency key makes retries safe; the generated pspRef is also checked
   * before any write.
   */
  async recordPayment(
    id: string,
    dto: RecordPlanPaymentDto,
    user: AuthenticatedUser,
  ): Promise<PaymentPlanDto> {
    if (!Number.isSafeInteger(dto.amountCents) || dto.amountCents <= 0) {
      throw new BadRequestException('amountCents must be a positive integer amount');
    }

    const plan = await this.findOwned(id, user);
    const reference = this.paymentReference(plan, dto);
    const existingPayment = await this.findExistingPayment(reference);
    if (existingPayment) {
      return this.get(id, user);
    }
    if (plan.status !== 'ACTIVE') {
      throw new ConflictException(`Plan is ${plan.status}; only ACTIVE plans accept payments`);
    }

    const remainingCents = plan.installments.reduce(
      (sum, installment) => sum + installmentRemaining(installment),
      0,
    );
    if (dto.amountCents > remainingCents) {
      throw new BadRequestException(
        `amountCents exceeds the plan's remaining balance (${remainingCents})`,
      );
    }

    // A plan is backed by real receivables.  Never let an installment-only
    // ledger claim that money was collected when there is no unpaid invoice.
    const invoices = await this.prisma.invoice.findMany({
      where: {
        buildingId: plan.buildingId,
        unitId: plan.unitId,
        status: {
          notIn: [PaymentStatus.PAID, PaymentStatus.REFUNDED],
        },
      },
      orderBy: [{ periodYearMonth: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        buildingId: true,
        unitId: true,
        periodYearMonth: true,
        totalCents: true,
        paidCents: true,
      },
    });

    const outstandingCents = invoices.reduce(
      (sum, invoice) =>
        sum + Math.max(0, invoice.totalCents - invoice.paidCents),
      0,
    );
    if (outstandingCents <= 0) {
      throw new BadRequestException('The plan has no unpaid invoices to settle');
    }
    if (dto.amountCents > outstandingCents) {
      throw new BadRequestException(
        `amountCents exceeds the unit's outstanding invoice balance (${outstandingCents})`,
      );
    }

    let invoiceAllocations: PlanInvoiceAllocation[];
    try {
      invoiceAllocations = allocatePlanPaymentToInvoices(invoices, dto.amountCents);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Unable to allocate plan payment',
      );
    }

    const paidAt = new Date();
    const result = applyPaymentToPlan(plan.installments, dto.amountCents, paidAt);
    const touched = result.installments
      .map((updated) => ({
        updated,
        original: plan.installments.find((i) => i.id === updated.id),
      }))
      .filter(
        ({ updated, original }) =>
          original &&
          (original.paidCents !== updated.paidCents ||
            original.paidAt?.getTime() !== updated.paidAt?.getTime()),
      );

    const operations: Prisma.PrismaPromise<unknown>[] = [];
    for (const [allocationIndex, allocation] of invoiceAllocations.entries()) {
      const invoice = invoices.find((row) => row.id === allocation.invoiceId);
      if (!invoice) {
        throw new BadRequestException('Invoice disappeared while recording payment');
      }
      const newPaidCents = invoice.paidCents + allocation.amountCents;
      operations.push(
        this.prisma.payment.create({
          data: {
            invoiceId: invoice.id,
            method: PaymentMethod.IRIS,
            pspRef:
              allocationIndex === 0
                ? reference
                : `${reference}:${invoice.id}`,
            amountCents: allocation.amountCents,
            status: PaymentStatus.PAID,
          },
        }),
      );
      operations.push(
        this.prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            paidCents: { increment: allocation.amountCents },
            status:
              newPaidCents >= invoice.totalCents
                ? PaymentStatus.PAID
                : PaymentStatus.PENDING,
          },
        }),
      );
    }
    operations.push(
      ...touched.map(({ updated }) =>
        this.prisma.paymentPlanInstallment.update({
          where: { id: updated.id },
          data: { paidCents: updated.paidCents, paidAt: updated.paidAt },
        }),
      ),
    );
    if (result.completed) {
      operations.push(
        this.prisma.paymentPlan.update({
          where: { id: plan.id },
          data: { status: 'COMPLETED' },
        }),
      );
    }

    // An array transaction gives us one atomic commit for Payment + invoice +
    // installment writes.  Serializable isolation makes a concurrent retry
    // fail/retry at the database boundary rather than double-applying money.
    try {
      await this.prisma.$transaction(operations, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      // Payment.pspRef is unique in the additive payment-safety schema.  A
      // concurrent retry can therefore lose the race safely; return the
      // already-settled plan instead of exposing a duplicate-write error.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const replay = await this.findExistingPayment(reference);
        if (replay) return this.get(id, user);
      }
      throw error;
    }

    this.audit.record({
      buildingId: plan.buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'payment-plan.payment',
      entity: 'payment_plan',
      entityId: plan.id,
      metadata: {
        amountCents: result.appliedCents,
        allocations: result.allocations,
        invoiceAllocations,
        paymentReference: reference,
        completed: result.completed,
      },
    });

    return this.get(id, user);
  }

  /**
   * Cancels an ACTIVE plan.  Installments are intentionally retained: their
   * paid/unpaid state is the cancellation history and deleting them would make
   * a later audit or replay unable to explain what happened.
   */
  async cancel(id: string, user: AuthenticatedUser): Promise<PaymentPlanDto> {
    const plan = await this.findOwned(id, user);
    if (plan.status === 'CANCELLED') {
      return this.toPlanDto(plan);
    }
    if (plan.status !== 'ACTIVE') {
      throw new ConflictException(`Plan is already ${plan.status}`);
    }

    const cancelled = plan.installments.filter(
      (installment) => installmentRemaining(installment) > 0,
    );
    const cancelledCents = cancelled.reduce(
      (sum, installment) => sum + installmentRemaining(installment),
      0,
    );
    const cancelledAt = new Date();

    await this.prisma.$transaction([
      this.prisma.paymentPlan.update({
        where: { id: plan.id },
        data: { status: 'CANCELLED', cancelledAt },
      }),
    ]);

    this.audit.record({
      buildingId: plan.buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'payment-plan.cancel',
      entity: 'payment_plan',
      entityId: plan.id,
      metadata: {
        unitId: plan.unitId,
        cancelledInstallments: cancelled.map((installment) => ({
          seq: installment.seq,
          amountCents: installment.amountCents,
          paidCents: installment.paidCents,
          remainingCents: installmentRemaining(installment),
        })),
        cancelledCents,
      },
    });

    return this.get(id, user);
  }

  /**
   * RESIDENT view: the caller's own active plan schedule, resolved through an
   * effective ownership link in the active building.  A resident with more
   * than one owned unit must provide unitId; silently choosing one is not a
   * safe or deterministic API contract.
   */
  async myActivePlan(
    user: AuthenticatedUser,
    unitId?: string,
  ): Promise<PaymentPlanDto> {
    const buildingId = requireActiveBuildingId(user);
    const at = new Date();
    const ownerships = await this.prisma.ownership.findMany({
      where: effectiveOwnershipWhere(user.id, buildingId, at),
    });
    const ownedUnitIds = [
      ...new Set(
        ownerships
          .filter((ownership) => isEffectiveOwnership(ownership, at))
          .map((ownership) => ownership.unitId),
      ),
    ];
    if (ownedUnitIds.length === 0) {
      throw new ForbiddenException('User has no effective ownership in the active building');
    }
    if (unitId && !ownedUnitIds.includes(unitId)) {
      throw new ForbiddenException('You do not own the requested unit');
    }
    if (!unitId && ownedUnitIds.length > 1) {
      throw new BadRequestException(
        'Multiple units are owned; specify unitId for the active payment plan',
      );
    }

    const [onlyOwnedUnitId] = ownedUnitIds;
    const selectedUnitId = unitId ?? onlyOwnedUnitId;
    if (!selectedUnitId) {
      throw new ForbiddenException('User has no effective ownership in the active building');
    }
    const plan = await this.prisma.paymentPlan.findFirst({
      where: { unitId: { in: [selectedUnitId] }, buildingId, status: 'ACTIVE' },
      ...PLAN_WITH_SCHEDULE,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    if (!plan) throw new NotFoundException('No active payment plan');

    return this.toPlanDto(plan);
  }

  /** Unit arrears scoped to the building that was authorized for the plan. */
  private async arrearsFor(buildingId: string, unitId: string): Promise<number> {
    const invoices = await this.prisma.invoice.findMany({
      where: {
        buildingId,
        unitId,
        status: { not: PaymentStatus.REFUNDED },
      },
      select: { totalCents: true, paidCents: true },
    });
    return invoices.reduce(
      (sum, invoice) =>
        sum + Math.max(0, invoice.totalCents - invoice.paidCents),
      0,
    );
  }

  private async findOwned(
    id: string,
    user: AuthenticatedUser,
  ): Promise<PlanWithSchedule> {
    const plan = await this.prisma.paymentPlan.findFirst({
      where: { id },
      ...PLAN_WITH_SCHEDULE,
    });
    if (!plan) throw new NotFoundException('Payment plan not found');
    assertSameBuilding(user, plan.buildingId);
    return plan;
  }

  private paymentReference(
    plan: PlanWithSchedule,
    dto: RecordPlanPaymentDto,
  ): string {
    const raw = dto.idempotencyKey?.trim();
    // Without an explicit key, make a same-amount replay idempotent as a
    // conservative default.  Callers that intentionally make two equal-valued
    // payments must provide distinct idempotency keys.
    const suffix = raw && raw.length > 0 ? raw : `amount-${dto.amountCents}`;
    return `${PLAN_PAYMENT_PREFIX}:${plan.id}:${suffix}`;
  }

  private async findExistingPayment(
    reference: string,
  ): Promise<{ id: string } | null> {
    const paymentDelegate = (
      this.prisma as unknown as {
        payment?: { findFirst?: (args: unknown) => Promise<{ id: string } | null> };
      }
    ).payment;
    if (!paymentDelegate?.findFirst) return null;
    return paymentDelegate.findFirst({
      where: {
        OR: [
          { pspRef: reference },
          { pspRef: { startsWith: `${reference}:` } },
        ],
      },
      select: { id: true },
    });
  }

  private assertKnownStatus(status?: string): void {
    if (status && !PLAN_STATUSES.includes(status as PaymentPlanStatus)) {
      throw new BadRequestException(
        `status must be one of ${PLAN_STATUSES.join(', ')}`,
      );
    }
  }

  private toPlanDto(plan: PlanWithSchedule): PaymentPlanDto {
    const paidCents = plan.installments.reduce((sum, i) => sum + i.paidCents, 0);
    return {
      id: plan.id,
      buildingId: plan.buildingId,
      unitId: plan.unitId,
      totalCents: plan.totalCents,
      installmentCount: plan.installmentCount,
      status: plan.status as PaymentPlanStatus,
      createdAt: plan.createdAt.toISOString(),
      cancelledAt: plan.cancelledAt ? plan.cancelledAt.toISOString() : null,
      paidCents,
      remainingCents: Math.max(0, plan.totalCents - paidCents),
      unitLabel: plan.unit?.label ?? null,
      installments: plan.installments.map((installment) =>
        this.toInstallmentDto(installment),
      ),
    };
  }

  private toInstallmentDto(installment: PaymentPlanInstallment): InstallmentDto {
    return {
      id: installment.id,
      planId: installment.planId,
      seq: installment.seq,
      dueDate: installment.dueDate.toISOString(),
      amountCents: installment.amountCents,
      paidCents: installment.paidCents,
      paidAt: installment.paidAt ? installment.paidAt.toISOString() : null,
    };
  }
}
