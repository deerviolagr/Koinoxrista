import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PaymentMethod, PaymentOrderState, PaymentStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { BankImportService } from './bank-import.service';

const user: AuthenticatedUser = {
  id: 'admin-1',
  email: 'admin@example.gr',
  role: 'ADMIN',
  buildingId: 'building-1',
};

const CSV = '2026-08-03;100,00;BANK-REF-1;EUR\n';

function makePrisma() {
  const order = {
    id: 'order-1',
    orderCode: 'BANK-REF-1',
    amountCents: 10_000,
    currency: 'EUR',
    provider: 'viva',
    sessionRef: 'BANK-REF-1',
    status: PaymentOrderState.PENDING,
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    invoice: {
      id: 'invoice-1',
      buildingId: 'building-1',
      totalCents: 10_000,
      paidCents: 0,
      periodYearMonth: '2026-07',
      unit: { label: 'Α1' },
      building: { currency: 'EUR' },
    },
  };
  const tx = {
    paymentOrder: {
      findUnique: jest.fn().mockResolvedValue(order),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
    payment: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'payment-created' }),
    },
    invoice: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'invoice-1',
        totalCents: 10_000,
        paidCents: 0,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    building: {
      findUnique: jest.fn().mockResolvedValue({ currency: 'EUR' }),
    },
    paymentOrder: {
      findMany: jest.fn().mockResolvedValue([order]),
      findUnique: jest.fn(),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    __tx: tx,
    __order: order,
  };
  return prisma;
}

function audit() {
  return { record: jest.fn() } as unknown as AuditService;
}

describe('BankImportService — pending checkout reconciliation', () => {
  it('previews pending PaymentOrders, not arbitrary PENDING Payment rows', async () => {
    const prisma = makePrisma();
    const service = new BankImportService(prisma as unknown as PrismaService, audit());

    await expect(service.preview('building-1', user, CSV)).resolves.toEqual({
      rows: [{ dateIso: '2026-08-03', amountCents: 10_000, reference: 'BANK-REF-1', currency: 'EUR' }],
      pending: [
        expect.objectContaining({
          paymentId: 'order-1',
          amountCents: 10_000,
        }),
      ],
      suggestions: [{ rowIndex: 0, paymentId: 'order-1', confidence: 'high' }],
    });
    expect(prisma.paymentOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: PaymentOrderState.PENDING,
          invoice: { buildingId: 'building-1' },
        },
      }),
    );
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });

  it('settles the order, creates the PAID Payment and updates the invoice atomically', async () => {
    const prisma = makePrisma();
    const auditStub = audit();
    const service = new BankImportService(prisma as unknown as PrismaService, auditStub);

    await expect(
      service.apply('building-1', user, {
        csv: CSV,
        matches: [{ rowIndex: 0, paymentId: 'order-1' }],
      }),
    ).resolves.toEqual({ applied: 1, skipped: 0 });

    const tx = prisma.__tx;
    expect(tx.paymentOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'order-1',
          status: PaymentOrderState.PENDING,
          amountCents: 10_000,
          currency: 'EUR',
        }),
        data: expect.objectContaining({
          status: PaymentOrderState.COMPLETED,
          pspRef: 'BANK-REF-1',
          eventRef: expect.any(String),
        }),
      }),
    );
    expect(tx.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoiceId: 'invoice-1',
          paymentOrderId: 'order-1',
          provider: 'viva',
          currency: 'EUR',
          eventRef: expect.any(String),
          method: PaymentMethod.IRIS,
          pspRef: 'BANK-REF-1',
          amountCents: 10_000,
          status: PaymentStatus.PAID,
        }),
      }),
    );
    expect(tx.invoice.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'invoice-1',
        paidCents: { lte: 0 },
      },
      data: {
        paidCents: { increment: 10_000 },
        status: PaymentStatus.PAID,
      },
    });
  });

  it.each([
    ['amount', '2026-08-03;99,99;BANK-REF-1;EUR'],
    ['reference', '2026-08-03;100,00;OTHER-REF;EUR'],
    ['currency', '2026-08-03;100,00;BANK-REF-1;USD'],
  ])('rejects an exact %s mismatch before settlement', async (_label, csv) => {
    const prisma = makePrisma();
    const service = new BankImportService(prisma as unknown as PrismaService, audit());

    await expect(
      service.apply('building-1', user, {
        csv,
        matches: [{ rowIndex: 0, paymentId: 'order-1' }],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.__tx.paymentOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.__tx.payment.create).not.toHaveBeenCalled();
  });

  it('rejects a stale order that would make a wrong partial settlement', async () => {
    const prisma = makePrisma();
    prisma.__tx.paymentOrder.findUnique.mockResolvedValue({
      ...prisma.__order,
      amountCents: 5_000,
    });
    const service = new BankImportService(prisma as unknown as PrismaService, audit());

    await expect(
      service.apply('building-1', user, {
        csv: '2026-08-03;50,00;BANK-REF-1;EUR',
        matches: [{ rowIndex: 0, paymentId: 'order-1' }],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.__tx.payment.create).not.toHaveBeenCalled();
  });

  it('does not replay a bank reference to another order', async () => {
    const prisma = makePrisma();
    prisma.__tx.payment.findFirst.mockResolvedValue({
      id: 'payment-old',
      invoiceId: 'invoice-other',
    });
    const service = new BankImportService(prisma as unknown as PrismaService, audit());

    await expect(
      service.apply('building-1', user, {
        csv: CSV,
        matches: [{ rowIndex: 0, paymentId: 'order-1' }],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.__tx.paymentOrder.updateMany).not.toHaveBeenCalled();
  });

  it('keeps duplicate matches within one request idempotent', async () => {
    const prisma = makePrisma();
    const service = new BankImportService(prisma as unknown as PrismaService, audit());

    await expect(
      service.apply('building-1', user, {
        csv: CSV,
        matches: [
          { rowIndex: 0, paymentId: 'order-1' },
          { rowIndex: 0, paymentId: 'order-1' },
        ],
      }),
    ).resolves.toEqual({ applied: 1, skipped: 1 });
  });

  it('enforces building tenancy', async () => {
    const prisma = makePrisma();
    const outsider = { ...user, buildingId: 'building-2' };
    const service = new BankImportService(prisma as unknown as PrismaService, audit());
    await expect(service.preview('building-1', outsider, CSV)).rejects.toThrow(
      ForbiddenException,
    );
  });
});
