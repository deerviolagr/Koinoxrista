import { BadRequestException } from '@nestjs/common';
import { PaymentMethod, PaymentStatus } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentPlansService } from './payment-plans.service';
import { allocatePlanPaymentToInvoices } from './payment-plan-settlement';

const admin: AuthenticatedUser = {
  id: 'admin-1',
  email: 'admin@example.gr',
  role: 'ADMIN',
  buildingId: 'building-1',
};

function plan() {
  return {
    id: 'plan-1',
    buildingId: 'building-1',
    unitId: 'unit-a',
    totalCents: 10_000,
    installmentCount: 2,
    status: 'ACTIVE',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    cancelledAt: null,
    unit: { label: 'A' },
    installments: [
      {
        id: 'inst-1',
        planId: 'plan-1',
        seq: 1,
        dueDate: new Date('2026-07-01T00:00:00.000Z'),
        amountCents: 5_000,
        paidCents: 0,
        paidAt: null,
      },
      {
        id: 'inst-2',
        planId: 'plan-1',
        seq: 2,
        dueDate: new Date('2026-08-01T00:00:00.000Z'),
        amountCents: 5_000,
        paidCents: 0,
        paidAt: null,
      },
    ],
  };
}

describe('payment plan invoice settlement', () => {
  it('allocates the oldest unpaid invoices first', () => {
    expect(
      allocatePlanPaymentToInvoices(
        [
          {
            id: 'newer',
            unitId: 'unit-a',
            buildingId: 'building-1',
            periodYearMonth: '2026-05',
            totalCents: 5_000,
            paidCents: 4_000,
          },
          {
            id: 'oldest',
            unitId: 'unit-a',
            buildingId: 'building-1',
            periodYearMonth: '2026-04',
            totalCents: 5_000,
            paidCents: 0,
          },
        ],
        2_000,
      ),
    ).toEqual([
      { invoiceId: 'oldest', periodYearMonth: '2026-04', amountCents: 2_000 },
    ]);
  });

  it('creates real Payment rows and updates invoices/installments atomically', async () => {
    const currentPlan = plan();
    const invoices = [
      {
        id: 'oldest-invoice',
        buildingId: 'building-1',
        unitId: 'unit-a',
        periodYearMonth: '2026-04',
        totalCents: 5_000,
        paidCents: 0,
      },
      {
        id: 'newer-invoice',
        buildingId: 'building-1',
        unitId: 'unit-a',
        periodYearMonth: '2026-05',
        totalCents: 5_000,
        paidCents: 0,
      },
    ];
    const prisma = {
      paymentPlan: {
        findFirst: jest.fn().mockResolvedValue(currentPlan),
      },
      invoice: {
        findMany: jest.fn().mockResolvedValue(invoices),
        update: jest.fn().mockResolvedValue({}),
      },
      payment: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'payment-1' }),
      },
      paymentPlanInstallment: {
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    };
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new PaymentPlansService(
      prisma as unknown as PrismaService,
      audit,
    );

    await service.recordPayment(
      'plan-1',
      { amountCents: 6_000, idempotencyKey: 'request-1' },
      admin,
    );

    expect(prisma.payment.create).toHaveBeenCalledTimes(2);
    expect(prisma.payment.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        invoiceId: 'oldest-invoice',
        method: PaymentMethod.IRIS,
        amountCents: 5_000,
        status: PaymentStatus.PAID,
        pspRef: 'payment-plan:plan-1:request-1',
      }),
    });
    expect(prisma.invoice.update).toHaveBeenCalledWith({
      where: { id: 'oldest-invoice' },
      data: {
        paidCents: { increment: 5_000 },
        status: PaymentStatus.PAID,
      },
    });
    expect(prisma.paymentPlanInstallment.update).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('treats a replayed idempotency key as a no-op', async () => {
    const prisma = {
      paymentPlan: { findFirst: jest.fn().mockResolvedValue(plan()) },
      invoice: { findMany: jest.fn(), update: jest.fn() },
      payment: {
        findFirst: jest.fn().mockResolvedValue({ id: 'payment-existing' }),
        create: jest.fn(),
      },
      paymentPlanInstallment: { update: jest.fn() },
      $transaction: jest.fn(),
    };
    const service = new PaymentPlansService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
    );

    await service.recordPayment(
      'plan-1',
      { amountCents: 1_000, idempotencyKey: 'same-request' },
      admin,
    );

    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an overpayment before creating a Payment', async () => {
    const prisma = {
      paymentPlan: { findFirst: jest.fn().mockResolvedValue(plan()) },
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'invoice-1',
            buildingId: 'building-1',
            unitId: 'unit-a',
            periodYearMonth: '2026-04',
            totalCents: 100,
            paidCents: 0,
          },
        ]),
        update: jest.fn(),
      },
      payment: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      paymentPlanInstallment: { update: jest.fn() },
      $transaction: jest.fn(),
    };
    const service = new PaymentPlansService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
    );

    await expect(
      service.recordPayment('plan-1', { amountCents: 101 }, admin),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
