import { Role } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  maintenanceOccurrenceKey,
  MaintenanceService,
} from './maintenance.service';

const actor = {
  id: 'owner-1',
  email: 'owner@example.test',
  role: Role.BUILDING_OWNER,
  buildingId: 'building-1',
};

function schedule(nextDueAt: string) {
  return {
    id: 'schedule-1',
    assetId: 'asset-1',
    buildingId: 'building-1',
    title: 'Lift service',
    intervalMonths: 6,
    lastDoneAt: null,
    nextDueAt: new Date(nextDueAt),
    autoCreateJob: true,
    expenseCategoryId: null,
    asset: { id: 'asset-1', name: 'Lift', category: 'ELEVATOR' },
  };
}

describe('MaintenanceService occurrence identity', () => {
  it('uses schedule id plus due timestamp as the occurrence key', () => {
    expect(maintenanceOccurrenceKey('s1', new Date('2026-08-25T10:00:00Z'))).toBe(
      's1@2026-08-25T10:00:00.000Z',
    );
  });

  it('creates a new job for a later occurrence with the same title', async () => {
    const tx = {
      jobRun: {
        create: jest.fn().mockResolvedValue({ id: 'run-1' }),
        update: jest.fn().mockResolvedValue({ id: 'run-1' }),
      },
      job: { create: jest.fn().mockResolvedValue({ id: 'job-1' }) },
    };
    const prisma = {
      maintenanceSchedule: {
        findMany: jest.fn().mockResolvedValue([
          schedule('2026-08-26T10:00:00Z'),
        ]),
      },
      membership: { findMany: jest.fn().mockResolvedValue([{ userId: 'owner-1' }]) },
      $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      jobRun: tx.jobRun,
      job: tx.job,
      user: { findMany: jest.fn() },
    };
    const notifications = { createForUsers: jest.fn().mockResolvedValue(undefined) };
    const service = new MaintenanceService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as any,
      notifications as any,
    );

    await expect(service.generateDueJobs('building-1', actor)).resolves.toEqual({
      created: 1,
      skipped: 0,
    });
    expect(tx.jobRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        buildingId: 'building-1',
        jobType: 'maintenance.schedule:schedule-1',
        period: '2026-08-26T10:00:00.000Z',
      }),
    });
    expect(tx.job.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: 'MAINTENANCE_SCHEDULE',
        description: expect.stringContaining('schedule-1@2026-08-26T10:00:00.000Z'),
      }),
    });
  });
});
