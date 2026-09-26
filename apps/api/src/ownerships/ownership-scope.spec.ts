import {
  effectiveOwnershipWhere,
  endOfBillingPeriod,
  isEffectiveOwnership,
} from './ownership-scope';

describe('ownership scope', () => {
  const at = new Date('2026-06-30T12:00:00.000Z');

  it('uses inclusive period bounds and excludes ended ownerships', () => {
    expect(
      isEffectiveOwnership(
        {
          periodStart: new Date('2026-01-01T00:00:00.000Z'),
          periodEnd: at,
        },
        at,
      ),
    ).toBe(true);
    expect(
      isEffectiveOwnership(
        {
          periodStart: new Date('2026-01-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-30T11:59:59.999Z'),
        },
        at,
      ),
    ).toBe(false);
  });

  it('anchors a monthly lookup to the active building and period end', () => {
    const where = effectiveOwnershipWhere(
      'resident-1',
      'building-1',
      endOfBillingPeriod('2026-06'),
      'unit-a',
    );

    expect(where).toMatchObject({
      userId: 'resident-1',
      unitId: 'unit-a',
      unit: { buildingId: 'building-1' },
      AND: expect.any(Array),
    });
  });
});
