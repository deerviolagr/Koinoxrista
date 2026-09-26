import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import {
  assertSameBuilding,
  effectiveBuildingRole,
  isOwnerRole,
} from '../common/tenant';
import { PrismaService } from '../prisma/prisma.service';

export {
  effectiveBuildingRole,
  effectiveRole,
  isAdminLikeRole,
  isOwnerRole,
  roleSatisfies,
} from '../common/tenant';

/** Allow-list of granular permission keys. */
export const PERMISSION_KEYS = [
  'billing.manage',
  'members.manage',
  'compliance.manage',
  'legal.manage',
  'votes.manage',
  'documents.manage',
  'treasury.manage',
  'reports.view',
  'settings.manage',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const isPermissionKey = (key: string): key is PermissionKey =>
  (PERMISSION_KEYS as readonly string[]).includes(key);

export interface EffectivePermissionContext {
  role: Role | null;
  isOwner: boolean;
}

/**
 * Building-scoped authorization. `User.buildingId` is the active tenant;
 * Membership rows are consulted first so the role for that tenant is not
 * confused with a role held in another building.
 */
@Injectable()
export class PermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Resolve the effective role and whether it is the building owner. */
  async contextFor(
    user: AuthenticatedUser,
    buildingId: string,
  ): Promise<EffectivePermissionContext> {
    const role = await effectiveBuildingRole(this.prisma, user, buildingId);
    return { role, isOwner: isOwnerRole(role) };
  }

  /**
   * Effective permission check for `user` in `buildingId`.
   * BUILDING_OWNER implicitly holds every permission; an ADMIN needs a row.
   */
  async can(
    user: AuthenticatedUser,
    buildingId: string,
    key: PermissionKey,
  ): Promise<boolean> {
    if (!user.buildingId || user.buildingId !== buildingId) return false;
    const role = await effectiveBuildingRole(this.prisma, user, buildingId);
    if (role === Role.BUILDING_OWNER) return true;
    if (role !== Role.ADMIN) return false;

    const row = await this.prisma.adminPermission.findUnique({
      where: {
        userId_buildingId_permissionKey: {
          userId: user.id,
          buildingId,
          permissionKey: key,
        },
      },
      select: { id: true },
    });
    return !!row;
  }

  /** Guard variant: throws 403 when not allowed. */
  async require(
    user: AuthenticatedUser,
    buildingId: string,
    key: PermissionKey,
  ): Promise<void> {
    if (!(await this.can(user, buildingId, key))) {
      throw new ForbiddenException(`Missing permission: ${key}`);
    }
  }

  /** BUILDING_OWNER only: list every admin + their granted keys. */
  async listAdmins(buildingId: string, user: AuthenticatedUser) {
    assertSameBuilding(user, buildingId);
    await this.requireOwner(buildingId, user);

    const db = this.prisma as unknown as {
      membership?: {
        findMany: (args: unknown) => Promise<Array<{
          userId: string;
          role: Role;
          user?: {
            id: string;
            email: string;
            firstName: string;
            lastName: string;
          } | null;
        }>>;
      };
      user?: {
        findMany: (args: unknown) => Promise<Array<{
          id: string;
          email: string;
          firstName: string;
          lastName: string;
          role: Role;
        }>>;
      };
    };

    let admins: Array<{
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      role: Role;
    }> = [];
    if (db.membership?.findMany) {
      const memberships = (await db.membership.findMany({
        where: {
          buildingId,
          role: { in: [Role.ADMIN, Role.BUILDING_OWNER] },
        },
        select: {
          userId: true,
          role: true,
          user: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
        orderBy: { user: { email: 'asc' } },
      })) ?? [];
      admins = memberships.flatMap((membership) => {
        if (!membership.user) return [];
        return [{
          id: membership.userId,
          email: membership.user.email,
          firstName: membership.user.firstName,
          lastName: membership.user.lastName,
          // Membership.role wins over the stale active User.role.
          role: membership.role,
        }];
      });
    }

    // Compatibility for legacy installations that have no Membership rows.
    if (admins.length === 0 && db.user?.findMany) {
      admins = await db.user.findMany({
        where: { buildingId, role: { in: [Role.ADMIN, Role.BUILDING_OWNER] } },
        select: { id: true, email: true, firstName: true, lastName: true, role: true },
        orderBy: { email: 'asc' },
      });
    }

    const grants = await this.prisma.adminPermission.findMany({
      where: { buildingId },
      select: { userId: true, permissionKey: true },
    });
    const byUser = new Map<string, string[]>();
    for (const grant of grants) {
      const list = byUser.get(grant.userId) ?? [];
      if (!list.includes(grant.permissionKey)) list.push(grant.permissionKey);
      byUser.set(grant.userId, list);
    }
    return admins.map((admin) => ({
      ...admin,
      permissions: byUser.get(admin.id) ?? [],
    }));
  }

  /** BUILDING_OWNER only: replace an admin's granted keys (audited). */
  async setPermissions(
    buildingId: string,
    targetUserId: string,
    keys: string[],
    user: AuthenticatedUser,
  ): Promise<void> {
    assertSameBuilding(user, buildingId);
    const actorRole = await this.requireOwner(buildingId, user);

    const db = this.prisma as unknown as {
      membership?: {
        findFirst: (args: unknown) => Promise<{
          userId: string;
          role: Role;
        } | null>;
      };
      user?: {
        findFirst: (args: unknown) => Promise<{
          id: string;
        } | null>;
      };
    };

    let target: { userId: string; role: Role } | null = null;
    if (db.membership?.findFirst) {
      target = await db.membership.findFirst({
        where: { userId: targetUserId, buildingId, role: Role.ADMIN },
        select: { userId: true, role: true },
      });
    }
    if (!target && db.user?.findFirst) {
      const legacy = await db.user.findFirst({
        where: { id: targetUserId, buildingId, role: Role.ADMIN },
        select: { id: true },
      });
      if (legacy) target = { userId: legacy.id, role: Role.ADMIN };
    }
    if (!target) {
      throw new NotFoundException('Target admin not found in building');
    }
    if (!keys.every(isPermissionKey)) {
      throw new ForbiddenException('Contains an unknown permission key');
    }
    const uniqueKeys = [...new Set(keys)];

    const operations = [
      this.prisma.adminPermission.deleteMany({
        where: { buildingId, userId: targetUserId },
      }),
    ];
    if (uniqueKeys.length > 0) {
      operations.push(
        this.prisma.adminPermission.createMany({
          data: uniqueKeys.map((key) => ({
            userId: targetUserId,
            buildingId,
            permissionKey: key,
            grantedById: user.id,
          })),
        }),
      );
    }
    await this.prisma.$transaction(operations);

    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole,
      action: 'permissions.set',
      entity: 'user',
      entityId: targetUserId,
      metadata: { keys: uniqueKeys },
    });
  }

  /** Defense-in-depth owner check used by the controller and service. */
  private async requireOwner(
    buildingId: string,
    user: AuthenticatedUser,
  ): Promise<Role> {
    const role = await effectiveBuildingRole(this.prisma, user, buildingId);
    if (role !== Role.BUILDING_OWNER) {
      throw new ForbiddenException('Only building owners manage permissions');
    }
    return role;
  }
}
