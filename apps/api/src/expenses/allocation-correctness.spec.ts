import { BadRequestException } from '@nestjs/common';
import { AllocationStrategy } from '@prisma/client';

import { resolveAllocationWeights } from './allocation-weights';

describe('allocation weight safety', () => {
  it('rejects negative or fractional weights before splitting', () => {
    expect(() =>
      resolveAllocationWeights(
        [
          { id: 'a', millimes: 500, radiatorCount: -1 },
          { id: 'b', millimes: 500, radiatorCount: 2 },
        ],
        AllocationStrategy.RADIATORS,
      ),
    ).toThrow(BadRequestException);
  });

  it('does not silently omit a unit with a missing area/share weight', () => {
    expect(() =>
      resolveAllocationWeights(
        [
          { id: 'a', millimes: 500, squareMeters: 50 },
          { id: 'b', millimes: 500, squareMeters: null },
        ],
        AllocationStrategy.SQUARE_METERS,
      ),
    ).toThrow(/every unit/);
    expect(() =>
      resolveAllocationWeights(
        [
          { id: 'a', millimes: 500, shareFraction: 500 },
          { id: 'b', millimes: 500, shareFraction: null },
        ],
        AllocationStrategy.SHARE_FRACTION,
      ),
    ).toThrow(/every unit/);
  });

  it('routes METERS through readings rather than a fabricated zero weight', () => {
    expect(() =>
      resolveAllocationWeights(
        [{ id: 'a', millimes: 1000 }],
        AllocationStrategy.METERS,
      ),
    ).toThrow(/reading/i);
  });
});
