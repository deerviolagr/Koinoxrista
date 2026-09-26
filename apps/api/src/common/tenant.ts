import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { isValidPeriod } from '@org/shared';

import { AuthenticatedUser } from '../auth/auth.types';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Roles that can administer a building.  Keep this list in one place: a
 * number of services used to check only `user.role`, which is the user's
 * active-building pointer and can be stale when Memberships are used.
 */
export const ADMIN_LIKE_ROLES: readonly Role[] = [
  Role.ADMIN,
  Role.BUILDING_OWNER,
];

export function isAdminLikeRole(role: Role | null | undefined): boolean {
  return role === Role.ADMIN || role === Role.BUILDING_OWNER;
}

export function isAdminLike(user: Pick<AuthenticatedUser, 'role'>): boolean {
  return isAdminLikeRole(user.role);
}

export function isOwnerRole(role: Role | null | undefined): boolean {
  return role === Role.BUILDING_OWNER;
}

/**
 * Resolve the role to use for a building-scoped operation.  Membership is the
 * authoritative multi-building grant; the active User row remains a safe
 * compatibility fallback for installations created before Membership rows
 * existed.
 */
export async function effectiveBuildingRole(
  prisma: PrismaService,
  user: AuthenticatedUser,
  buildingId: string,
): Promise<Role | null> {
  const membershipReader = (prisma as unknown as {
    membership?: {
      findUnique?: (args: unknown) => Promise<{ role: Role } | null>;
    };
  }).membership;
  if (membershipReader?.findUnique) {
    const membership = await membershipReader.findUnique({
      where: { userId_buildingId: { userId: user.id, buildingId } },
      select: { role: true },
    });
    if (membership) return membership.role;
  }
  return user.buildingId === buildingId ? user.role : null;
}

/**
 * Resolve a role without making callers duplicate the membership query.  A
 * caller that has already loaded a membership may pass it in; otherwise the
 * active User role is used.
 */
export function effectiveRole(
  user: Pick<AuthenticatedUser, 'role'>,
  membershipRole?: Role | null,
): Role | null {
  return membershipRole ?? user.role;
}

/**
 * Central role-satisfaction rule used by the HTTP guard.  BUILDING_OWNER is
 * deliberately a superset of ADMIN, while PLATFORM_ADMIN remains isolated
 * from building roles.  Mixed metadata arrays therefore work as intended
 * (for example `@Roles(ADMIN, RESIDENT)` still admits an owner through the
 * ADMIN branch).
 */
export function roleSatisfies(
  requiredRoles: readonly Role[],
  userRole: Role | null | undefined,
): boolean {
  if (!userRole || requiredRoles.length === 0) return false;
  // An explicitly requested role always wins, including a mixed metadata
  // array such as [PLATFORM_ADMIN, ADMIN].
  if (requiredRoles.includes(userRole)) return true;
  if (requiredRoles.includes(Role.PLATFORM_ADMIN)) return false;
  return userRole === Role.BUILDING_OWNER && requiredRoles.includes(Role.ADMIN);
}

/** Deduplicated membership audience, with a legacy User-row fallback. */
export async function membershipUserIds(
  prisma: PrismaService,
  buildingId: string,
  roles: readonly Role[],
): Promise<string[]> {
  const membership = prisma.membership as
    | {
        findMany?: (args: unknown) => Promise<Array<{ userId: string }>>;
      }
    | undefined;
  if (membership?.findMany) {
    const rows = (await membership.findMany({
      where: { buildingId, role: { in: [...roles] } },
      select: { userId: true },
      distinct: ['userId'],
    })) ?? [];
    return [...new Set(rows.map((row) => row.userId))];
  }

  // Only used by lightweight unit-test doubles / pre-Membership data.  The
  // real Prisma client always takes the branch above.
  const users = prisma.user as
    | { findMany?: (args: unknown) => Promise<Array<{ id: string }>> }
    | undefined;
  if (!users?.findMany) return [];
  const rows = (await users.findMany({
    where: { buildingId, role: { in: [...roles] } },
    select: { id: true },
  })) ?? [];
  return [...new Set(rows.map((row) => row.id))];
}

export function assertSameBuilding(
  user: AuthenticatedUser,
  buildingId: string,
): void {
  if (!user.buildingId || user.buildingId !== buildingId) {
    throw new ForbiddenException('Access to another building is not allowed');
  }
}

export function requireValidPeriod(periodYearMonth: string | undefined): string {
  if (!periodYearMonth || !isValidPeriod(periodYearMonth)) {
    throw new BadRequestException('periodYearMonth must match YYYY-MM');
  }
  return periodYearMonth;
}
