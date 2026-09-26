/** Ownership / Occupancy types — mirrors Prisma Ownership + tenancy fragment. */
import type { OccupantType } from './tenancy';

export interface Ownership {
  id: string;
  unitId: string;
  userId: string;
  /** Greek ownership portion in millimes (‰ of 1000). */
  shareMillimes: number;
  /** ISO date string when the occupancy starts; null means open-ended. */
  periodStart?: string | null;
  /** ISO date string when the occupancy ends; null means open-ended. */
  periodEnd?: string | null;
  /** OWNER vs TENANT split — added by tenancy SCHEMA_ADDITION */
  occupantType: OccupantType;
  /** Whether this occupant may vote (stored for audit, computed eligibility may differ) */
  votingEligible: boolean;
  /** Optional mirrored role for this occupancy (e.g. RESIDENT, TENANT) */
  residentRole?: string | null;
  /** Joined user info (when listing) */
  user?: { firstName: string; lastName: string; email: string } | null;
}

export interface CreateOwnershipDto {
  userId: string;
  shareMillimes: number;
  periodStart?: string | null;
  periodEnd?: string | null;
  occupantType?: OccupantType;
  votingEligible?: boolean;
  residentRole?: string | null;
}

export interface OccupancyView extends Ownership {
  unitLabel?: string;
}
