import { ForbiddenException } from '@nestjs/common';

import { KpiService } from './kpi.service';

const user = (buildingId = 'building-1') =>
  ({
    id: 'admin-1',
    email: 'admin@example.test',
    role: 'ADMIN',
    buildingId,
  }) as any;

function makePrisma() {
  const snapshot = {
    id: 'snapshot-1',
    buildingId: 'building-1',
    weekStart: new Date('2027-01-11T00:00:00.000Z'),
    invoicedCents: 1000,
    collectedCents: 500,
    arrearsCents: 500,
    arrearsUnits: 1,
    collectionRate: 0.5,
    openJobs: 2,
    newDefects: 1,
    createdAt: new Date('2027-01-11T00:00:00.000Z'),
  };
  return {
    invoice: {
      findMany: jest.fn().mockResolvedValue([
        {
          unitId: 'unit-1',
          totalCents: 1000,
          paidCents: 500,
          unit: { label: 'A1' },
        },
      ]),
    },
    unit: { findMany: jest.fn().mockResolvedValue([]) },
    job: { count: jest.fn().mockResolvedValue(0) },
    buildingWeeklySnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue(snapshot),
    },
    alertRule: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

describe('KpiService reliability', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-01-15T12:00:00.000Z'));
  });

  afterEach(() => jest.useRealTimers());

  it('uses valid period bounds and counts awarded/in-progress jobs', async () => {
    const prisma = makePrisma();
    const service = new KpiService(
      prisma as any,
      { record: jest.fn() } as any,
      { create: jest.fn() } as any,
    );

    await service.snapshot(
      'building-1',
      user(),
      new Date('2027-01-15T12:00:00.000Z'),
    );

    const invoiceCall = prisma.invoice.findMany.mock.calls[0][0];
    expect(invoiceCall.where).toMatchObject({
      buildingId: 'building-1',
      periodYearMonth: { gte: '2027-01', lte: '2027-01' },
    });
    if (invoiceCall.where.issuedAt) {
      expect(invoiceCall.where.issuedAt).toEqual({
        gte: new Date('2027-01-11T00:00:00.000Z'),
        lt: new Date('2027-01-18T00:00:00.000Z'),
      });
    } else {
      expect(invoiceCall.where).not.toHaveProperty('issuedAt');
    }

    expect(prisma.job.count).toHaveBeenNthCalledWith(1, {
      where: {
        buildingId: 'building-1',
        status: { in: ['OPEN', 'AWARDED', 'IN_PROGRESS'] },
      },
    });
    const defectWhere = prisma.job.count.mock.calls[1][0].where;
    expect(defectWhere).toMatchObject({
      buildingId: 'building-1',
      source: 'RESIDENT_REPORT',
    });
    if (defectWhere.createdAt) {
      expect(defectWhere.createdAt).toEqual({
        gte: new Date('2027-01-11T00:00:00.000Z'),
        lt: new Date('2027-01-18T00:00:00.000Z'),
      });
    }
  });

  it('does not turn current state into eight historical backfill rows', async () => {
    const prisma = makePrisma();
    const service = new KpiService(
      prisma as any,
      { record: jest.fn() } as any,
      { create: jest.fn() } as any,
    );

    await expect(service.backfill('building-1', user())).resolves.toBe(0);
    expect(prisma.buildingWeeklySnapshot.upsert).not.toHaveBeenCalled();
  });

  it('enforces the tenant boundary before snapshot, backfill, and anomaly queries', async () => {
    const prisma = makePrisma();
    const service = new KpiService(
      prisma as any,
      { record: jest.fn() } as any,
      { create: jest.fn() } as any,
    );
    const foreign = user('building-2');

    await expect(service.snapshot('building-1', foreign)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.backfill('building-1', foreign)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.checkAnomalies('building-1', foreign)).rejects.toThrow(
      ForbiddenException,
    );

    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(prisma.alertRule.findMany).not.toHaveBeenCalled();
  });

  it('uses a valid period query for the arrears forecast too', async () => {
    const prisma = makePrisma();
    const service = new KpiService(
      prisma as any,
      { record: jest.fn() } as any,
      { create: jest.fn() } as any,
    );

    await service.forecastArrears('building-1', user());

    const where = prisma.invoice.findMany.mock.calls[0][0].where;
    expect(where.periodYearMonth).toEqual({ gte: '2026-07', lte: '2027-01' });
    if (where.issuedAt) {
      expect(where.issuedAt).toEqual(
        expect.objectContaining({
          gte: expect.any(Date),
          lt: expect.any(Date),
        }),
      );
    } else if (where.createdAt) {
      expect(where.createdAt).toEqual(
        expect.objectContaining({
          gte: expect.any(Date),
          lt: expect.any(Date),
        }),
      );
    } else {
      expect(where).not.toHaveProperty('issuedAt');
      expect(where).not.toHaveProperty('createdAt');
    }
  });
});
