import { BadRequestException } from '@nestjs/common';
import { AllocationStrategy } from '@prisma/client';
import { TOTAL_MILLIMES } from '@org/shared';

import type { SplitInput } from '../prisma/split-by-largest-remainder';

export interface AllocatableUnit {
  id: string;
  millimes: number;
  floor?: number | null;
  radiatorCount?: number;
  squareMeters?: number | null;
  shareFraction?: number | null;
}

/**
 * Strategies that have a complete implementation in this API.  METERS is
 * implemented by ExpensesService because its weights come from readings, not
 * from Unit columns.  CUSTOM has no persisted per-unit weight definition and
 * is therefore rejected at category configuration time.
 */
export const SUPPORTED_ALLOCATION_STRATEGIES = [
  AllocationStrategy.MILIMES,
  AllocationStrategy.UNITS,
  AllocationStrategy.RADIATORS,
  AllocationStrategy.ELEVATOR_FLOORS,
  AllocationStrategy.METERS,
  AllocationStrategy.SQUARE_METERS,
  AllocationStrategy.SHARE_FRACTION,
  AllocationStrategy.HEADCOUNT,
] as const;

export function isSupportedAllocationStrategy(
  strategy: string,
): strategy is AllocationStrategy {
  return (SUPPORTED_ALLOCATION_STRATEGIES as readonly string[]).includes(
    strategy,
  );
}

export function assertSupportedAllocationStrategy(strategy: string): void {
  if (strategy === AllocationStrategy.CUSTOM) {
    throw new BadRequestException(
      'CUSTOM allocation not supported yet',
    );
  }
  if (!isSupportedAllocationStrategy(strategy)) {
    throw new BadRequestException(`Unsupported allocation strategy: ${strategy}`);
  }
}

function weightFor(
  unit: AllocatableUnit,
  strategy: AllocationStrategy,
): number {
  switch (strategy) {
    case AllocationStrategy.MILIMES:
      return unit.millimes;
    case AllocationStrategy.UNITS:
      return 1;
    case AllocationStrategy.RADIATORS:
      return unit.radiatorCount ?? 0;
    case AllocationStrategy.ELEVATOR_FLOORS:
      // Ground floors and units without a floor are intentionally exempt.
      return Math.max(unit.floor ?? 0, 0);
    case AllocationStrategy.SQUARE_METERS:
      // Scale m² → integer hundredths so the integer-weight split stays exact.
      return Math.round((unit.squareMeters ?? 0) * 100);
    case AllocationStrategy.SHARE_FRACTION:
      return unit.shareFraction ?? 0;
    case AllocationStrategy.HEADCOUNT:
      // Per-unit equal weights regardless of ownership basis.
      return 1;
    case AllocationStrategy.METERS:
      throw new BadRequestException(
        'METERS allocation requires a reading for every unit; calculate it through the meter service',
      );
    case AllocationStrategy.CUSTOM:
      throw new BadRequestException(
        'CUSTOM allocation not supported yet',
      );
    default:
      throw new BadRequestException(
        `Unsupported allocation strategy: ${String(strategy)}`,
      );
  }
}

/** Human-readable requirement for zero-total validation (pure). */
function strategyRequirement(strategy: AllocationStrategy): string | null {
  switch (strategy) {
    case AllocationStrategy.RADIATORS:
      return 'radiatorCount > 0';
    case AllocationStrategy.ELEVATOR_FLOORS:
      return 'floor >= 1';
    case AllocationStrategy.SQUARE_METERS:
      return 'squareMeters > 0';
    case AllocationStrategy.SHARE_FRACTION:
      return 'shareFraction > 0';
    default:
      return null;
  }
}

function assertCompleteStrategyWeights(
  units: AllocatableUnit[],
  strategy: AllocationStrategy,
  weights: number[],
): void {
  if (units.length === 0) {
    throw new BadRequestException('At least one unit is required for allocation');
  }
  const ids = new Set<string>();
  for (const unit of units) {
    if (!unit.id || ids.has(unit.id)) {
      throw new BadRequestException('Allocation units must have unique ids');
    }
    ids.add(unit.id);
  }
  for (let index = 0; index < weights.length; index++) {
    const weight = weights[index];
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new BadRequestException(
        `Allocation weight for unit ${units[index].id} must be a non-negative integer`,
      );
    }
  }

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const requirement = strategyRequirement(strategy);
  if (totalWeight <= 0 && requirement) {
    throw new BadRequestException(
      `Category strategy requires at least one unit with ${requirement}`,
    );
  }
  if (totalWeight <= 0) {
    throw new BadRequestException('Allocation weights must have a positive total');
  }
  if (strategy === AllocationStrategy.MILIMES && totalWeight !== TOTAL_MILLIMES) {
    throw new BadRequestException(
      `MILIMES allocation weights must total ${TOTAL_MILLIMES}`,
    );
  }
  // Area and ownership-share allocation cannot silently treat a missing
  // attribute as a zero share.  Zero is valid only for the explicitly exempt
  // strategies (elevator floors and radiators).
  if (strategy === AllocationStrategy.SQUARE_METERS) {
    const missing = units.find(
      (unit) =>
        unit.squareMeters === null ||
        unit.squareMeters === undefined ||
        !Number.isFinite(unit.squareMeters) ||
        unit.squareMeters <= 0,
    );
    if (missing) {
      throw new BadRequestException(
        `Category strategy requires squareMeters > 0 for every unit; missing unit: ${missing.id}`,
      );
    }
  }
  if (strategy === AllocationStrategy.SHARE_FRACTION) {
    const missing = units.find(
      (unit) =>
        unit.shareFraction === null ||
        unit.shareFraction === undefined ||
        !Number.isSafeInteger(unit.shareFraction) ||
        unit.shareFraction <= 0,
    );
    if (missing) {
      throw new BadRequestException(
        `Category strategy requires shareFraction > 0 for every unit; missing unit: ${missing.id}`,
      );
    }
  }
  if (
    strategy === AllocationStrategy.SHARE_FRACTION &&
    totalWeight !== 1000
  ) {
    throw new BadRequestException(
      'SHARE_FRACTION allocation weights must total 1000',
    );
  }
  if (strategy === AllocationStrategy.MILIMES) {
    const invalid = units.find(
      (unit) => !Number.isSafeInteger(unit.millimes) || unit.millimes <= 0,
    );
    if (invalid) {
      throw new BadRequestException(
        `Category strategy requires millimes > 0 for every unit; invalid unit: ${invalid.id}`,
      );
    }
  }
}

/**
 * Resolve one integer weight per unit.  Every input unit is retained,
 * including intentional zero-weight exemptions, and every returned weight is
 * checked before the largest-remainder splitter sees it.
 */
export function resolveAllocationWeights(
  units: AllocatableUnit[],
  strategy: AllocationStrategy,
): SplitInput[] {
  assertSupportedAllocationStrategy(strategy);
  const inputs = units.map((unit) => ({
    id: unit.id,
    weight: weightFor(unit, strategy),
  }));
  assertCompleteStrategyWeights(
    units,
    strategy,
    inputs.map((input) => input.weight),
  );
  return inputs;
}
