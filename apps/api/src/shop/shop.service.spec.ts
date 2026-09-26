import { NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShopService } from './shop.service';

const admin: AuthenticatedUser = {
  id: 'admin-1',
  email: 'admin@example.gr',
  role: Role.ADMIN,
  buildingId: 'building-1',
};
const resident: AuthenticatedUser = {
  id: 'resident-1',
  email: 'resident@example.gr',
  role: Role.RESIDENT,
  buildingId: 'building-1',
};

function makePrisma(order: Record<string, any>) {
  const tx = {
    productOrder: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(order),
    },
  };
  return {
    productOrder: {
      findFirst: jest.fn().mockResolvedValue(order),
      findUnique: jest.fn().mockResolvedValue(order),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    ownership: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    __tx: tx,
  };
}

const audit = () => ({ record: jest.fn() }) as unknown as AuditService;

const order = (overrides: Record<string, unknown> = {}) => ({
  id: 'order-1',
  buildingId: 'building-1',
  unitId: 'unit-1',
  unit: { buildingId: 'building-1', label: 'A1' },
  status: 'PENDING',
  ...overrides,
});

describe('ShopService tenant and settlement safety', () => {
  it('does not mark an order from another building paid', async () => {
    const prisma = makePrisma(order({ buildingId: 'building-2', unit: { buildingId: 'building-2' } }));
    const service = new ShopService(prisma as unknown as PrismaService, audit());

    await expect(
      service.markPaid('building-1', 'order-1', admin),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.__tx.productOrder.updateMany).not.toHaveBeenCalled();
  });

  it('does not expose all building history to a resident with no owned unit', async () => {
    const prisma = makePrisma(order());
    const service = new ShopService(prisma as unknown as PrismaService, audit());

    await expect(service.orders('building-1', resident)).resolves.toEqual([]);
    expect(prisma.productOrder.findMany).not.toHaveBeenCalled();
  });

  it('makes repeated markPaid calls idempotent', async () => {
    const prisma = makePrisma(order());
    const service = new ShopService(prisma as unknown as PrismaService, audit());

    await service.markPaid('building-1', 'order-1', admin);
    prisma.productOrder.findFirst.mockResolvedValue(order({ status: 'PAID' }));
    await service.markPaid('building-1', 'order-1', admin);

    expect(prisma.__tx.productOrder.updateMany).toHaveBeenCalledTimes(1);
  });
});
