import { ConflictException } from '@nestjs/common';
import { Role } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from './jobs.service';

const admin = {
  id: 'admin-1',
  email: 'admin@example.test',
  role: Role.ADMIN,
  buildingId: 'building-1',
};

function bid(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bid-1',
    jobId: 'job-1',
    providerUserId: 'provider-1',
    amountCents: 5000,
    message: null,
    status: 'SUBMITTED',
    ratingStars: null,
    provider: {
      firstName: 'N',
      lastName: 'P',
      profile: { trade: 'Plumber' },
    },
    ...overrides,
  };
}

describe('JobsService governance contracts', () => {
  it('excludes maintenance work and returns stable provider bid identity', async () => {
    const prisma = {
      job: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'job-1',
            buildingId: 'building-1',
            source: 'ADMIN_RFP',
            building: { name: 'A' },
            title: 'Public job',
            description: 'd',
            status: 'OPEN',
            budgetCents: 100,
            bids: [bid()],
          },
          {
            id: 'job-maint',
            buildingId: 'building-1',
            source: 'MAINTENANCE_SCHEDULE',
            building: { name: 'A' },
            title: 'Internal maintenance',
            description: 'd',
            status: 'OPEN',
            budgetCents: 100,
            bids: [],
          },
        ]),
      },
      bid: { findMany: jest.fn() },
      user: { findMany: jest.fn() },
      membership: { findUnique: jest.fn() },
      notifications: {},
      commissions: {},
    };
    const service = new JobsService(
      prisma as unknown as PrismaService,
      { createForUsers: jest.fn() } as any,
      { createForAward: jest.fn() } as any,
    );

    const jobs = await service.marketplace('provider-1');
    const job = jobs[0];
    expect(jobs).toHaveLength(1);
    expect(prisma.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'OPEN',
          source: { notIn: ['RESIDENT_REPORT', 'MAINTENANCE_SCHEDULE'] },
        },
      }),
    );
    expect(job.buildingId).toBe('building-1');
    expect(job.bids[0].providerUserId).toBe('provider-1');
  });

  it('does not create two bids for the same provider/job in one service instance', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'OPEN', buildingId: 'building-1', title: 'Job' }) },
      bid: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(bid()),
        update: jest.fn(),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new JobsService(
      prisma as unknown as PrismaService,
      { createForUsers: jest.fn(), create: jest.fn() } as any,
      { createForAward: jest.fn() } as any,
    );
    const user = {
      id: 'provider-1',
      email: 'provider@example.test',
      role: Role.PROVIDER,
      buildingId: null,
    };

    await service.createBid('job-1', { amountCents: 5000 }, user);
    await expect(
      service.createBid('job-1', { amountCents: 6000 }, user),
    ).rejects.toThrow(ConflictException);
    expect(prisma.bid.create).toHaveBeenCalledTimes(1);
  });

  it('claims an OPEN job exactly once before accepting a bid', async () => {
    const tx = {
      bid: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue({
          ...bid(),
          job: { id: 'job-1', buildingId: 'building-1', status: 'OPEN' },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(bid({ status: 'ACCEPTED' })),
      },
      job: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      membership: { findUnique: jest.fn() },
    };
    const service = new JobsService(
      prisma as unknown as PrismaService,
      { create: jest.fn(), createForUsers: jest.fn() } as any,
      { createForAward: jest.fn().mockResolvedValue(null) } as any,
    );

    await expect(service.acceptBid('bid-1', admin)).rejects.toThrow(
      ConflictException,
    );
    expect(tx.bid.update).not.toHaveBeenCalled();
  });
});
