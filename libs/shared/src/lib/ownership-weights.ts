/**
 * Ownership weight basis (P0-3, docs/INTERNATIONAL_PLAN §5). Greece votes and
 * allocates by millimes (‰ of 1000, N.1221/1981). International buildings may
 * weight by ownership share (NA HOA, `shareFraction` ‰) or by usable area
 * (EU/NA, `squareMeters`). The chosen basis must be complete and consistent
 * across all units of a building; silently treating a missing value as zero
 * can under-allocate an expense or distort a vote.
 */

export type OwnershipWeightBasis = 'MILLIMES' | 'SHARE_FRACTION' | 'SQUARE_METERS';

export interface WeightedUnit {
  millimes: number;
  squareMeters?: number | null;
  shareFraction?: number | null;
}

export const DEFAULT_OWNERSHIP_BASIS: OwnershipWeightBasis = 'MILLIMES';

export class IncompleteOwnershipWeightError extends Error {
  readonly code = 'INCOMPLETE_OWNERSHIP_BASIS';
  readonly basis: OwnershipWeightBasis;

  constructor(basis: OwnershipWeightBasis, message?: string) {
    super(
      message ??
        `Incomplete ownership basis ${basis}: every unit must provide a positive ${basis} value`,
    );
    this.name = 'IncompleteOwnershipWeightError';
    this.basis = basis;
  }
}

function hasPositiveWeight(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
}

function assertComplete(
  units: readonly WeightedUnit[],
  basis: OwnershipWeightBasis,
): void {
  if (units.length === 0) return;
  const valueFor = (unit: WeightedUnit): number | null | undefined => {
    switch (basis) {
      case 'SHARE_FRACTION':
        return unit.shareFraction;
      case 'SQUARE_METERS':
        return unit.squareMeters;
      case 'MILLIMES':
        return unit.millimes;
    }
  };
  const missing = units.filter((unit) => !hasPositiveWeight(valueFor(unit)));
  if (missing.length > 0) {
    throw new IncompleteOwnershipWeightError(
      basis,
      `Incomplete ownership basis ${basis}: ${missing.length} unit(s) lack a positive value`,
    );
  }
}

/**
 * Picks the ownership-weight basis for a building from its full unit list.
 * A basis is selected only when every unit has a positive value.  If both
 * international bases are fully populated, shareFraction wins for backwards
 * compatibility; partially populated/mixed bases are rejected.
 */
export function resolveOwnershipBasis(
  units: readonly WeightedUnit[],
): OwnershipWeightBasis {
  const hasShare = units.some((unit) => hasPositiveWeight(unit.shareFraction));
  const hasSquare = units.some((unit) => hasPositiveWeight(unit.squareMeters));

  if (hasShare) {
    assertComplete(units, 'SHARE_FRACTION');
    // When callers provide both international bases, do not silently ignore
    // a partially populated area column. Either both are complete or the
    // building must remove the unused basis.
    if (hasSquare) assertComplete(units, 'SQUARE_METERS');
    return 'SHARE_FRACTION';
  }
  if (hasSquare) {
    assertComplete(units, 'SQUARE_METERS');
    return 'SQUARE_METERS';
  }
  return DEFAULT_OWNERSHIP_BASIS;
}

export function assertOwnershipBasisComplete(
  units: readonly WeightedUnit[],
  basis: OwnershipWeightBasis = resolveOwnershipBasis(units),
): void {
  assertComplete(units, basis);
}

export const validateOwnershipWeights = assertOwnershipBasisComplete;

/**
 * Integer weight of a single unit under a given basis. Square meters are
 * scaled ×100 to integer hundredths so the largest-remainder split engine
 * (which requires integer weights) stays exact.
 */
export function unitOwnershipWeight(
  unit: WeightedUnit,
  basis: OwnershipWeightBasis = DEFAULT_OWNERSHIP_BASIS,
): number {
  switch (basis) {
    case 'SHARE_FRACTION':
      if (!hasPositiveWeight(unit.shareFraction)) {
        throw new IncompleteOwnershipWeightError(basis);
      }
      if (!Number.isSafeInteger(unit.shareFraction)) {
        throw new TypeError('shareFraction must be a positive safe integer');
      }
      return unit.shareFraction;
    case 'SQUARE_METERS':
      if (!hasPositiveWeight(unit.squareMeters)) {
        throw new IncompleteOwnershipWeightError(basis);
      }
      return Math.round(unit.squareMeters * 100);
    case 'MILLIMES':
    default:
      assertFiniteNonNegative(unit.millimes, 'millimes');
      if (!Number.isSafeInteger(unit.millimes)) {
        throw new TypeError('millimes must be a safe integer');
      }
      return unit.millimes;
  }
}

/** Total ownership weight of a building under a basis (integer). */
export function totalOwnershipWeight(
  units: readonly WeightedUnit[],
  basis: OwnershipWeightBasis = resolveOwnershipBasis(units),
): number {
  assertComplete(units, basis);
  const total = units.reduce(
    (sum, unit) => sum + unitOwnershipWeight(unit, basis),
    0,
  );
  if (!Number.isSafeInteger(total)) {
    throw new RangeError('ownership weight total exceeds the safe integer range');
  }
  return total;
}
