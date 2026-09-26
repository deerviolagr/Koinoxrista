import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { InspectionsService } from './inspections.service';

const provider = {
  id: 'provider-1',
  email: 'provider@example.test',
  role: Role.PROVIDER,
  buildingId: 'building-1',
};
const admin = {
  id: 'admin-1',
  email: 'admin@example.test',
  role: Role.ADMIN,
  buildingId: 'building-1',
};

function makePrisma() {
  return {
    membership: { findUnique: jest.fn().mockResolvedValue(null) },
    buildingAsset: { findFirst: jest.fn().mockResolvedValue({ id: 'asset-1' }) },
    job: { findFirst: jest.fn().mockResolvedValue({ id: 'job-1' }) },
    bid: { findFirst: jest.fn().mockResolvedValue(null) },
    inspectionRecord: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
    maintenanceSchedule: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
    workLog: { create: jest.fn().mockResolvedValue({ id: 'log-1' }) },
    supplierPayment: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

describe('InspectionsService provider job authorization', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: InspectionsService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new InspectionsService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
    );
    prisma.inspectionRecord.create.mockResolvedValue({
      id: 'inspection-1',
      assetId: 'asset-1',
      buildingId: 'building-1',
      inspectedAt: new Date('2026-01-01T00:00:00Z'),
      result: 'NG',
      photoKey: null,
      notes: null,
      jobId: 'job-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      inspector: { firstName: 'P', lastName: 'Provider' },
    });
  });

  it('requires a provider to name a job on the first inspection', async () => {
    await expect(
      service.create('building-1', 'asset-1', { result: 'NG' }, provider),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.inspectionRecord.create).not.toHaveBeenCalled();
  });

  it('rejects a provider whose bid is still submitted', async () => {
    prisma.bid.findFirst.mockResolvedValue(null);
    await expect(
      service.create(
        'building-1',
        'asset-1',
        { result: 'NG', jobId: 'job-1' },
        provider,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.inspectionRecord.create).not.toHaveBeenCalled();
  });

  it('accepts a provider with an ACCEPTED bid for a job in the same building', async () => {
    prisma.bid.findFirst.mockResolvedValue({ id: 'bid-1' });
    await expect(
      service.create(
        'building-1',
        'asset-1',
        { result: 'NG', jobId: 'job-1' },
        provider,
      ),
    ).resolves.toMatchObject({ jobId: 'job-1', result: 'NG' });
    expect(prisma.bid.findFirst).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        providerUserId: 'provider-1',
        status: 'ACCEPTED',
      },
      select: { id: true },
    });
  });

  it('rejects a job or asset from another building', async () => {
    prisma.job.findFirst.mockResolvedValue(null);
    await expect(
      service.create(
        'building-1',
        'asset-1',
        { result: 'NG', jobId: 'foreign-job' },
        provider,
      ),
    ).rejects.toThrow(NotFoundException);

    prisma.buildingAsset.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.create('building-1', 'foreign-asset', { result: 'NG' }, admin),
    ).rejects.toThrow(NotFoundException);
  });

  it('uses Membership role when the active User role is stale', async () => {
    prisma.membership.findUnique.mockResolvedValue({ role: Role.BUILDING_OWNER });
    prisma.inspectionRecord.create.mockResolvedValue({
      id: 'inspection-owner',
      assetId: 'asset-1',
      buildingId: 'building-1',
      inspectedAt: new Date(),
      result: 'OK',
      photoKey: null,
      notes: null,
      jobId: null,
      createdAt: new Date(),
      inspector: { firstName: 'O', lastName: 'Owner' },
    });
    await expect(
      service.create(
        'building-1',
        'asset-1',
        { result: 'OK' },
        { ...admin, role: Role.RESIDENT },
      ),
    ).resolves.toMatchObject({ id: 'inspection-owner' });
  });
});
