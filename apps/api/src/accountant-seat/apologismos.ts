import type {
  ApologismosCategoryTotal,
  ApologismosCostRow,
  ApologismosDto,
  ApologismosMonthlyPoint,
  ApologismosUnitBalance,
} from '@org/shared';

/** Expense totals grouped by category, straight from a Prisma `groupBy`. */
export interface ApologismosExpenseGroup {
  categoryId: string | null;
  _sum: { totalCents: number | null };
}

/** Supplier cash payments grouped/selected for the requested year. */
export interface ApologismosSupplierPayment {
  amountCents: number;
  categoryId?: string | null;
  expense?: { categoryId: string | null } | null;
}

export interface ApologismosBudgetRow {
  categoryId: string | null;
  categoryName: string;
  plannedCents: number;
}

export interface ApologismosInvoiceRow {
  periodYearMonth: string;
  totalCents: number;
  paidCents: number;
  unitId?: string;
}

export interface ApologismosInput {
  buildingId: string;
  buildingName: string;
  year: string;
  generatedAt: Date;
  /** Billed expense totals charged to residents. */
  expenseGroups: ApologismosExpenseGroup[];
  budgetRows: ApologismosBudgetRow[];
  /** Supplier cash actually paid during the year, when available. */
  supplierCashGroups?: ApologismosExpenseGroup[];
  supplierPayments?: ApologismosSupplierPayment[];
  invoices: ApologismosInvoiceRow[];
  unitBalances: ApologismosUnitBalance[];
  /** Unpaid balance from periods before `year`, keyed by unit id. */
  priorYearArrearsByUnit?: Record<string, number>;
}

export const APOLOGISMOS_YEAR_REGEX = /^\d{4}$/;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Ascending `YYYY-01`…`YYYY-12` window (pure). */
function yearPeriods(year: string): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${pad2(i + 1)}`);
}

function categoryKey(value: string | null | undefined): string | null {
  return value ?? null;
}

function categoryName(
  key: string | null,
  names: Map<string | null, string>,
): string {
  return (
    names.get(key) ??
    (key === null
      ? 'Λοιπές (χωρίς κατηγορία)'
      : `Κατηγορία ${String(key).slice(-6)}`)
  );
}

/**
 * Pure aggregation behind GET /accountant/buildings/:buildingId/apologismos.
 *
 * - income = billed expense totals charged to residents
 * - costs = supplier cash actually paid (not the billed expense total)
 * - monthly = current-year invoiced vs collected
 * - arrears = current-year arrears plus unpaid prior-year balances
 * - unitBalances = current-year statement balance plus opening arrears
 * - surplus/deficit = collected − supplier cash cost
 *
 * `supplierCashGroups`/`supplierPayments` are optional only for compatibility
 * with older pure-function callers.  The service always supplies an explicit
 * empty collection when there were no cash payments, so production reports do
 * not silently substitute billed expenses for cash cost.
 */
export function buildApologismos(
  input: ApologismosInput,
): ApologismosDto {
  const chargedByKey = new Map<string | null, number>();
  for (const group of input.expenseGroups ?? []) {
    const key = categoryKey(group.categoryId);
    chargedByKey.set(
      key,
      (chargedByKey.get(key) ?? 0) + (group._sum.totalCents ?? 0),
    );
  }

  const cashByKey = new Map<string | null, number>();
  const hasExplicitCash =
    input.supplierCashGroups !== undefined || input.supplierPayments !== undefined;
  if (input.supplierCashGroups) {
    for (const group of input.supplierCashGroups) {
      const key = categoryKey(group.categoryId);
      cashByKey.set(
        key,
        (cashByKey.get(key) ?? 0) + (group._sum.totalCents ?? 0),
      );
    }
  } else if (input.supplierPayments) {
    for (const payment of input.supplierPayments) {
      const key = categoryKey(
        payment.categoryId ?? payment.expense?.categoryId,
      );
      cashByKey.set(key, (cashByKey.get(key) ?? 0) + payment.amountCents);
    }
  }

  const nameByKey = new Map<string | null, string>();
  const plannedByKey = new Map<string | null, number>();
  for (const row of input.budgetRows ?? []) {
    const key = categoryKey(row.categoryId);
    nameByKey.set(key, row.categoryName);
    plannedByKey.set(
      key,
      (plannedByKey.get(key) ?? 0) + row.plannedCents,
    );
  }

  const incomeKeys = new Set<string | null>([
    ...chargedByKey.keys(),
    ...plannedByKey.keys(),
  ]);
  const incomeByCategory: ApologismosCategoryTotal[] = [...incomeKeys]
    .filter((key) => key !== null || (chargedByKey.get(null) ?? 0) > 0)
    .map((key) => ({
      categoryId: key,
      categoryName: categoryName(key, nameByKey),
      chargedCents: chargedByKey.get(key) ?? 0,
    }))
    .sort((a, b) => b.chargedCents - a.chargedCents);

  // Costs include budget-only, billed-only and cash-only categories.  When
  // no explicit cash dataset was supplied, retain the old pure-helper
  // behaviour for external callers; the service supplies [] explicitly.
  const cashForCost = (key: string | null): number =>
    hasExplicitCash ? cashByKey.get(key) ?? 0 : chargedByKey.get(key) ?? 0;
  const costKeys = new Set<string | null>([
    ...plannedByKey.keys(),
    ...chargedByKey.keys(),
    ...(hasExplicitCash ? cashByKey.keys() : []),
  ]);
  const costsByCategory: ApologismosCostRow[] = [...costKeys].map((key) => ({
    categoryId: key,
    categoryName: categoryName(key, nameByKey),
    plannedCents: plannedByKey.get(key) ?? 0,
    actualCents: cashForCost(key),
  }));

  const periods = yearPeriods(input.year);
  const invoiceSums = new Map<string, { total: number; paid: number }>();
  for (const invoice of input.invoices ?? []) {
    if (!periods.includes(invoice.periodYearMonth)) continue;
    const sums = invoiceSums.get(invoice.periodYearMonth) ?? {
      total: 0,
      paid: 0,
    };
    sums.total += invoice.totalCents;
    sums.paid += invoice.paidCents;
    invoiceSums.set(invoice.periodYearMonth, sums);
  }
  const monthly: ApologismosMonthlyPoint[] = periods.map((periodYearMonth) => {
    const sums = invoiceSums.get(periodYearMonth) ?? { total: 0, paid: 0 };
    return {
      periodYearMonth,
      invoicedCents: sums.total,
      collectedCents: sums.paid,
      arrearsCents: Math.max(0, sums.total - sums.paid),
    };
  });

  const priorArrearsByUnit = input.priorYearArrearsByUnit ?? {};
  const priorArrearsCents = Object.values(priorArrearsByUnit).reduce(
    (sum, value) => sum + Math.max(0, value),
    0,
  );
  const unitBalances = input.unitBalances.map((unit) => ({
    ...unit,
    balanceCents:
      unit.balanceCents + Math.max(0, priorArrearsByUnit[unit.unitId] ?? 0),
  }));

  const totals = {
    chargedCents: incomeByCategory.reduce(
      (sum, row) => sum + row.chargedCents,
      0,
    ),
    plannedCents: costsByCategory.reduce(
      (sum, row) => sum + row.plannedCents,
      0,
    ),
    actualCents: costsByCategory.reduce((sum, row) => sum + row.actualCents, 0),
    invoicedCents: monthly.reduce((sum, point) => sum + point.invoicedCents, 0),
    collectedCents: monthly.reduce(
      (sum, point) => sum + point.collectedCents,
      0,
    ),
    arrearsCents:
      monthly.reduce((sum, point) => sum + point.arrearsCents, 0) +
      priorArrearsCents,
    surplusDeficitCents: 0,
  };
  totals.surplusDeficitCents = totals.collectedCents - totals.actualCents;

  return {
    buildingId: input.buildingId,
    buildingName: input.buildingName,
    year: input.year,
    generatedAt: input.generatedAt.toISOString(),
    incomeByCategory,
    costsByCategory,
    monthly,
    unitBalances: [...unitBalances].sort((a, b) =>
      a.unitLabel.localeCompare(b.unitLabel, 'el'),
    ),
    totals,
  };
}
