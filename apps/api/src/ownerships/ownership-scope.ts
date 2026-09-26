import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';

/**
 * Ownership is a time-bounded link, rather than a permanent user-to-unit
 * mapping.  The schema currently has periodStart and (when the billing
 * migration is installed) nullable periodEnd.  Keep the date predicates in
 * one place so invoices, statements, plans, and resident ownership views all
 * use the same inclusive rule:
 *
 *   periodStart <= reference <= periodEnd (or the corresponding null bound)
 *
 * A period is evaluated at its last instant.  That makes a statement for a
 * month/year reflect the owner who was effective when that billing period
 * closed, while the normal resident views use "now".
 *
 * The small runtime capability check is intentional.  This branch can be
 * deployed before the optional Ownership.periodEnd migration; passing an
 * unknown Prisma field would make every query fail, so we only emit the
 * periodEnd predicate when the generated client knows about that field.
 */

export interface OwnershipDateFields {
  periodStart?: Date | string | null;
  periodEnd?: Date | string | null;
}

export function ownershipPeriodEndSupported(): boolean {
  try {
    const model = Prisma.dmmf.datamodel.models.find(
      (candidate) => candidate.name === 'Ownership',
    );
    return Boolean(model?.fields.some((field) => field.name === 'periodEnd'));
  } catch {
    // A mocked/minimal Prisma client may not expose dmmf.  In that case the
    // safe behavior is to use only fields that are known by the repository.
    return false;
  }
}

/** Last millisecond of a YYYY-MM billing month in UTC. */
export function endOfBillingPeriod(periodYearMonth: string): Date {
  const match = /^(\d{4})-(\d{2})$/.exec(periodYearMonth);
  if (!match) {
    // Callers normally validate this before reaching the scope helper.  Keep
    // the helper total for direct/unit-test use rather than producing NaN.
    return new Date(Number.NaN);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1 || month < 1 || month > 12) return new Date(Number.NaN);
  return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
}

/** Last millisecond of a YYYY year in UTC. */
export function endOfBillingYear(year: string): Date {
  const match = /^(\d{4})$/.exec(year);
  if (!match) return new Date(Number.NaN);
  const yearNumber = Number(match[1]);
  if (yearNumber < 1) return new Date(Number.NaN);
  return new Date(Date.UTC(yearNumber, 11, 31, 23, 59, 59, 999));
}

export function isEffectiveOwnership(
  ownership: OwnershipDateFields,
  at: Date,
): boolean {
  if (Number.isNaN(at.getTime())) return false;
  const start = ownership.periodStart
    ? new Date(ownership.periodStart)
    : null;
  const end = ownership.periodEnd ? new Date(ownership.periodEnd) : null;
  if (start && Number.isNaN(start.getTime())) return false;
  if (end && Number.isNaN(end.getTime())) return false;
  if (start && start > at) return false;
  if (end && end < at) return false;
  return true;
}

export function overlapsOwnershipPeriod(
  ownership: OwnershipDateFields,
  from: Date,
  to: Date,
): boolean {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return false;
  const start = ownership.periodStart
    ? new Date(ownership.periodStart)
    : null;
  const end = ownership.periodEnd ? new Date(ownership.periodEnd) : null;
  if (start && Number.isNaN(start.getTime())) return false;
  if (end && Number.isNaN(end.getTime())) return false;
  // Bounds are inclusive.  A null start/end means the ownership extends into
  // that side of time.
  if (end && end < from) return false;
  if (start && start > to) return false;
  return true;
}

type LooseWhere = Record<string, unknown>;

function effectiveDateWhere(at: Date | undefined): LooseWhere {
  if (!at || Number.isNaN(at.getTime())) return {};
  const clauses: LooseWhere[] = [
    { OR: [{ periodStart: null }, { periodStart: { lte: at } }] },
  ];
  if (ownershipPeriodEndSupported()) {
    clauses.push({
      OR: [{ periodEnd: null }, { periodEnd: { gte: at } }],
    });
  }
  return { AND: clauses };
}

/**
 * Prisma where fragment for one user's effective ownership in one active
 * building.  The return type is intentionally loose because periodEnd is an
 * additive schema field and the checked-in client may predate it.
 */
export function effectiveOwnershipWhere(
  userId: string,
  buildingId: string,
  at: Date,
  unitId?: string,
): LooseWhere {
  return {
    userId,
    ...(unitId ? { unitId } : {}),
    unit: { buildingId },
    ...effectiveDateWhere(at),
  };
}

/** Date/user fragment for a nested ownership relation. */
export function effectiveUserOwnershipWhere(
  userId: string,
  at: Date,
): LooseWhere {
  return {
    userId,
    ...effectiveDateWhere(at),
  };
}

/** Same rule for all owners of one unit (used for share-budget checks). */
export function effectiveUnitOwnershipWhere(
  unitId: string,
  at: Date,
): LooseWhere {
  return {
    unitId,
    ...effectiveDateWhere(at),
  };
}

/** All owners effective in one building at the supplied reference date. */
export function effectiveBuildingOwnershipWhere(
  buildingId: string,
  at: Date,
): LooseWhere {
  return {
    unit: { buildingId },
    ...effectiveDateWhere(at),
  };
}

/** Any ownership that overlaps an annual statement window. */
export function ownershipWindowWhere(
  unitId: string,
  buildingId: string,
  from: Date,
  to: Date,
): LooseWhere {
  const clauses: LooseWhere[] = [
    { OR: [{ periodStart: null }, { periodStart: { lte: to } }] },
  ];
  if (ownershipPeriodEndSupported()) {
    clauses.push({
      OR: [{ periodEnd: null }, { periodEnd: { gte: from } }],
    });
  }
  return {
    unitId,
    unit: { buildingId },
    AND: clauses,
  };
}

/** The user's active building is the tenancy boundary for resident reads. */
export function requireActiveBuildingId(user: AuthenticatedUser): string {
  if (!user.buildingId) {
    throw new ForbiddenException('An active building is required');
  }
  return user.buildingId;
}
