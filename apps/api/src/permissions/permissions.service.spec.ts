import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionsService } from './permissions.service';

const owner = {
  id: 'owner-1',
  email: 'owner@example.test',
  role: Role.BUILDING_OWNER,
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
    membership: {
      findUnique: jest.fn().mockResolvedValue({ role: Role.BUILDING_OWNER }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    adminPermission: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(async (operations: unknown[]) => operations),
  };
}

describe('PermissionsService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: PermissionsService;
  const audit = { record: jest.fn() } as unknown as AuditService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new PermissionsService(
      prisma as unknown as PrismaService,
      audit,
    );
  });

  it('uses Membership role for a mixed-role user and requires the grant for ADMIN', async () => {
    prisma.membership.findUnique.mockResolvedValue({ role: Role.ADMIN });
    prisma.adminPermission.findUnique.mockResolvedValue({ id: 'grant-1' });

    await expect(
      service.can({ ...admin, role: Role.RESIDENT }, 'building-1', 'votes.manage'),
    ).resolves.toBe(true);
    expect(prisma.membership.findUnique).toHaveBeenCalledWith({
      where: { userId_buildingId: { userId: 'admin-1', buildingId: 'building-1' } },
      select: { role: true },
    });
  });

  it('lets a Membership BUILDING_OWNER bypass granular grants', async () => {
    await expect(
      service.can({ ...owner, role: Role.RESIDENT }, 'building-1', 'billing.manage'),
    ).resolves.toBe(true);
    expect(prisma.adminPermission.findUnique).not.toHaveBeenCalled();
  });

  it('does not authorize a resident or a user from another building', async () => {
    prisma.membership.findUnique.mockResolvedValue(null);
    await expect(
      service.can({ ...admin, role: Role.RESIDENT }, 'building-1', 'votes.manage'),
    ).resolves.toBe(false);
    await expect(
      service.can({ ...admin, buildingId: 'building-2' }, 'building-1', 'votes.manage'),
    ).resolves.toBe(false);
  });

  it('lists the Membership role rather than the stale User role', async () => {
    prisma.membership.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        role: Role.ADMIN,
        user: {
          id: 'admin-1',
          email: 'admin@example.test',
          firstName: 'A',
          lastName: 'Admin',
        },
      },
    ]);
    const result = await service.listAdmins('building-1', owner);
    expect(result[0]).toMatchObject({ id: 'admin-1', role: Role.ADMIN });
  });

  it('rejects an ADMIN actor from changing permissions', async () => {
    prisma.membership.findUnique.mockResolvedValue({ role: Role.ADMIN });
    await expect(
      service.setPermissions('building-1', 'admin-2', ['votes.manage'], admin),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('deduplicates keys and records the owner grant replacement', async () => {
    prisma.membership.findFirst.mockResolvedValue({
      userId: 'admin-2',
      role: Role.ADMIN,
    });

    await service.setPermissions(
      'building-1',
      'admin-2',
      ['votes.manage', 'votes.manage'],
      owner,
    );

    expect(prisma.adminPermission.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId: 'admin-2',
          buildingId: 'building-1',
          permissionKey: 'votes.manage',
          grantedById: 'owner-1',
        },
      ],
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorRole: Role.BUILDING_OWNER }),
    );
  });
});
