/** Role / strategy / status unions mirroring the Prisma enums. */
import type { CurrencyCode } from './money';
import type {
  CreateOwnershipDto as OwnershipCreateDto,
  Ownership as OwnershipRecord,
} from './ownership';

export type Role =
  | 'ADMIN'
  | 'RESIDENT'
  | 'PROVIDER'
  | 'ACCOUNTANT'
  | 'PLATFORM_ADMIN'
  | 'BUILDING_OWNER';

export type AllocationStrategy =
  | 'MILIMES'
  | 'UNITS'
  | 'CUSTOM'
  | 'RADIATORS'
  | 'ELEVATOR_FLOORS'
  | 'SQUARE_METERS'
  | 'SHARE_FRACTION'
  | 'HEADCOUNT'
  | 'METERS';

export type PaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED';

export const TOTAL_MILLIMES = 1000;

export interface Unit {
  id: string;
  buildingId: string;
  label: string;
  floor?: number | null;
  millimes: number;
  radiatorCount: number;
  /** P0-3: usable area in m² (SQUARE_METERS strategy, EU/NA). */
  squareMeters?: number | null;
  /** P0-3: ownership share as integer ‰ of 1000 (SHARE_FRACTION, NA HOA). */
  shareFraction?: number | null;
}

export interface CreateUnitDto {
  label: string;
  floor?: number;
  millimes: number;
  radiatorCount?: number;
  squareMeters?: number;
  shareFraction?: number;
}

/** Canonical ownership contract (including tenancy/occupancy fields). */
export type Ownership = OwnershipRecord;
export type CreateOwnershipDto = OwnershipCreateDto;
export type { OccupancyView } from './ownership';

export interface ExpenseCategory {
  id: string;
  buildingId: string;
  name: string;
  strategy: AllocationStrategy;
}

export interface CreateExpenseCategoryDto {
  name: string;
  strategy: AllocationStrategy;
}

export interface Share {
  id: string;
  expenseId: string;
  unitId: string;
  amountCents: number;
  currency?: CurrencyCode;
}

export interface Expense {
  id: string;
  buildingId: string;
  categoryId: string;
  description: string;
  totalCents: number;
  periodYearMonth: string;
  createdById: string;
  createdAt?: string;
  shares?: Share[];
  currency?: CurrencyCode;
}

export interface CreateExpenseDto {
  categoryId: string;
  description: string;
  totalCents: number;
  periodYearMonth: string;
}

export interface Invoice {
  id: string;
  buildingId: string;
  unitId: string;
  periodYearMonth: string;
  totalCents: number;
  paidCents: number;
  status: PaymentStatus;
  currency?: CurrencyCode;
}

export interface RunInvoicesDto {
  periodYearMonth: string;
}
