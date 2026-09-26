import { buildApologismos } from './apologismos';

const base = {
  buildingId: 'building-1',
  buildingName: 'Κτίριο Α',
  year: '2025',
  generatedAt: new Date('2026-01-15T10:00:00Z'),
};

describe('buildApologismos', () => {
  it('aggregates income, costs vs budget, monthly series and surplus/deficit', () => {
    const dto = buildApologismos({
      ...base,
      expenseGroups: [
        { categoryId: 'cat-1', _sum: { totalCents: 120_000 } },
        { categoryId: 'cat-2', _sum: { totalCents: 30_000 } },
      ],
      budgetRows: [
        { categoryId: 'cat-1', categoryName: 'Ανελκυστήρας', plannedCents: 100_000 },
        { categoryId: 'cat-2', categoryName: 'Καθαριότητα', plannedCents: 40_000 },
        { categoryId: null, categoryName: 'Λοιπές (χωρίς κατηγορία)', plannedCents: 0 },
      ],
      invoices: [
        {
          periodYearMonth: '2025-01',
          totalCents: 80_000,
          paidCents: 70_000,

        },
        {
          periodYearMonth: '2025-02',
          totalCents: 50_000,
          paidCents: 50_000,

        },
        {
          periodYearMonth: '2024-12', // outside the year window → ignored
          totalCents: 999_999,
          paidCents: 0,

        },
      ],
      unitBalances: [
        {
          unitId: 'unit-2',
          unitLabel: 'Β',
          invoicedCents: 40_000,
          paidCents: 30_000,
          balanceCents: 10_000,
        },
        {
          unitId: 'unit-1',
          unitLabel: 'Α',
          ownerName: 'Νίκος Παπαδόπουλος',
          invoicedCents: 130_000,
          paidCents: 120_000,
          balanceCents: 10_000,
        },
      ],
    });

    expect(dto.incomeByCategory).toEqual([
      { categoryId: 'cat-1', categoryName: 'Ανελκυστήρας', chargedCents: 120_000 },
      { categoryId: 'cat-2', categoryName: 'Καθαριότητα', chargedCents: 30_000 },
    ]);
    expect(dto.costsByCategory.find((r) => r.categoryId === 'cat-1')).toEqual({
      categoryId: 'cat-1',
      categoryName: 'Ανελκυστήρας',
      plannedCents: 100_000,
      actualCents: 120_000,
    });
    expect(dto.monthly[0]).toEqual({
      periodYearMonth: '2025-01',
      invoicedCents: 80_000,
      collectedCents: 70_000,
      arrearsCents: 10_000,
    });
    expect(dto.monthly).toHaveLength(12);
    expect(dto.totals.invoicedCents).toBe(130_000);
    expect(dto.totals.collectedCents).toBe(120_000);
    expect(dto.totals.arrearsCents).toBe(10_000);
    // collected (120k) − actual costs (150k) = deficit
    expect(dto.totals.surplusDeficitCents).toBe(-30_000);
    // unit balances sort by Greek label
    expect(dto.unitBalances.map((u) => u.unitLabel)).toEqual(['Α', 'Β']);
    expect(dto.unitBalances[0].ownerName).toBe('Νίκος Παπαδόπουλος');
    expect(dto.generatedAt).toBe('2026-01-15T10:00:00.000Z');
  });

  it('defaults to zero-filled months and empty sections with no data', () => {
    const dto = buildApologismos({
      ...base,
      expenseGroups: [],
      budgetRows: [],
      invoices: [],
      unitBalances: [],
    });

    expect(dto.monthly).toHaveLength(12);
    expect(dto.totals).toEqual({
      chargedCents: 0,
      plannedCents: 0,
      actualCents: 0,
      invoicedCents: 0,
      collectedCents: 0,
      arrearsCents: 0,
      surplusDeficitCents: 0,
    });
    expect(dto.incomeByCategory).toEqual([]);
  });

  it('reports a surplus when collections exceed costs', () => {
    const dto = buildApologismos({
      ...base,
      expenseGroups: [{ categoryId: 'cat-1', _sum: { totalCents: 50_000 } }],
      budgetRows: [
        { categoryId: 'cat-1', categoryName: 'Καθαριότητα', plannedCents: 60_000 },
      ],
      invoices: [
        {
          periodYearMonth: '2025-03',
          totalCents: 90_000,
          paidCents: 90_000,

        },
      ],
      unitBalances: [],
    });

    expect(dto.totals.surplusDeficitCents).toBe(40_000);
  });

  it('separates billed expenses from supplier cash cost', () => {
    const dto = buildApologismos({
      ...base,
      expenseGroups: [{ categoryId: 'cat-1', _sum: { totalCents: 120_000 } }],
      budgetRows: [
        { categoryId: 'cat-1', categoryName: 'Maintenance', plannedCents: 100_000 },
      ],
      supplierPayments: [
        { amountCents: 80_000, expense: { categoryId: 'cat-1' } },
      ],
      invoices: [
        { periodYearMonth: '2025-03', totalCents: 100_000, paidCents: 100_000 },
      ],
      unitBalances: [],
    });

    expect(dto.incomeByCategory[0].chargedCents).toBe(120_000);
    expect(dto.costsByCategory[0].actualCents).toBe(80_000);
    expect(dto.totals.surplusDeficitCents).toBe(20_000);
  });

  it('carries unpaid prior-year invoices into year-end arrears and unit balances', () => {
    const dto = buildApologismos({
      ...base,
      expenseGroups: [],
      budgetRows: [],
      invoices: [
        { periodYearMonth: '2024-12', totalCents: 40_000, paidCents: 10_000 },
        { periodYearMonth: '2025-01', totalCents: 20_000, paidCents: 20_000 },
      ],
      unitBalances: [
        {
          unitId: 'unit-1',
          unitLabel: 'A',
          invoicedCents: 20_000,
          paidCents: 20_000,
          balanceCents: 0,
        },
      ],
      priorYearArrearsByUnit: { 'unit-1': 30_000 },
    });

    expect(dto.totals.arrearsCents).toBe(30_000);
    expect(dto.unitBalances[0].balanceCents).toBe(30_000);
  });
});
