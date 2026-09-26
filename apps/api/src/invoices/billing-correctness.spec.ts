import { BadRequestException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvoicesService } from './invoices.service';

const user: AuthenticatedUser = {
  id: 'admin-1',
  email: 'admin@example.gr',
  role: 'ADMIN',
  buildingId: 'building-1',
};

function makeService() {
  const prisma = {
    building: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'building-1',
        units: [
          { id: 'unit-a', label: 'A', millimes: 600 },
          { id: 'unit-b', label: 'B', millimes: 400 },
        ],
      }),
    },
    expense: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'expense-1',
          totalCents: 300,
          shares: [
            { unitId: 'unit-a', amountCents: 100 },
            { unitId: 'unit-b', amountCents: 200 },
          ],
        },
      ]),
    },
    invoice: {
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
    ownership: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  const audit = { record: jest.fn() } as unknown as AuditService;
  const notifications = {
    createForUsers: jest.fn(),
  } as unknown as NotificationsService;
  const service = new InvoicesService(
    prisma as unknown as PrismaService,
    audit,
    notifications,
  );
  return { service, prisma, audit, notifications };
}

describe('issued invoice immutability', () => {
  it('rejects a changed issued period before any invoice write', async () => {
    const { service, prisma } = makeService();
    prisma.invoice.findMany.mockResolvedValue([
      { unitId: 'unit-a', totalCents: 100, paidCents: 0 },
      { unitId: 'unit-b', totalCents: 999, paidCents: 0 },
    ]);

    await expect(
      service.run('building-1', { periodYearMonth: '2026-06' }, user),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.invoice.upsert).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('makes an unchanged rerun a no-op (no repricing or notification)', async () => {
    const { service, prisma, audit, notifications } = makeService();
    const issued = [
      { unitId: 'unit-a', totalCents: 100, paidCents: 0 },
      { unitId: 'unit-b', totalCents: 200, paidCents: 0 },
    ];
    prisma.invoice.findMany
      .mockResolvedValueOnce(issued)
      .mockResolvedValueOnce(issued);

    await expect(
      service.run('building-1', { periodYearMonth: '2026-06' }, user),
    ).resolves.toEqual(issued);
    expect(prisma.invoice.upsert).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(notifications.createForUsers).not.toHaveBeenCalled();
  });

  it('scopes resident invoices to the active building', async () => {
    const { service, prisma } = makeService();
    prisma.ownership.findMany.mockResolvedValue([
      { unitId: 'unit-a', periodStart: null, periodEnd: null },
    ]);
    prisma.invoice.findMany.mockResolvedValue([]);

    await service.findMine('2026-06', {
      ...user,
      id: 'resident-1',
      role: 'RESIDENT',
    });

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          buildingId: 'building-1',
          unitId: { in: ['unit-a'] },
        }),
      }),
    );
  });
});
