import { ConflictException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { LateFeesService } from './late-fees.service';

const admin: AuthenticatedUser = {
  id: 'admin-1',
  email: 'admin@example.gr',
  role: 'ADMIN',
  buildingId: 'building-1',
};

describe('late fee receivables safety', () => {
  afterEach(() => jest.restoreAllMocks());

  it('fails closed instead of creating a cosmetic active charge', async () => {
    const prisma = {
      lateFeeSetting: {
        findUnique: jest.fn().mockResolvedValue({
          graceDays: 0,
          mode: 'FLAT',
          dailyFlatCents: 100,
          dailyBps: 0,
          capCents: null,
        }),
      },
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'invoice-1',
            buildingId: 'building-1',
            unitId: 'unit-a',
            periodYearMonth: '2020-01',
            totalCents: 1_000,
            paidCents: 0,
            status: 'PENDING',
            unit: { label: 'A' },
          },
        ]),
      },
      lateFeeCharge: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
      },
    };
    const service = new LateFeesService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
    );
    jest.spyOn(Date, 'now').mockReturnValue(
      new Date('2026-06-01T00:00:00.000Z').getTime(),
    );

    await expect(service.run('building-1', { month: '2020-01' }, admin)).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.lateFeeCharge.create).not.toHaveBeenCalled();
  });
});
