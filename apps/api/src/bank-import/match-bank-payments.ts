import type {
  BankMatchConfidence,
  BankMatchSuggestionDto,
  ParsedBankRowDto,
} from '@org/shared';

/**
 * A pending checkout/order of the building, candidate for statement matching.
 * `paymentId` is kept as the public field name for wire compatibility; in the
 * current payment flow it contains the PaymentOrder id.  A Payment row is
 * created only when that order is actually settled.
 */
export interface PendingBankPayment {
  paymentId: string;
  amountCents: number;
  invoicePeriodYearMonth: string;
  createdAtIso: string;
  unitLabel: string;
  /** The exact bank reference accepted for this order (normally orderCode). */
  expectedReference?: string;
  /** ISO currency of the invoice/building, when known. */
  currency?: string;
}

export type ParsedBankRow = Omit<ParsedBankRowDto, 'currency'> & {
  currency?: string;
};

const DAY_MS = 86_400_000;
const WINDOW_MS = 5 * DAY_MS;

const RANK: Record<BankMatchConfidence, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function withinWindow(rowDateIso: string, createdAtIso: string): boolean {
  const rowMs = Date.parse(`${rowDateIso}T12:00:00Z`);
  const createdMs = Date.parse(createdAtIso);
  if (Number.isNaN(rowMs) || Number.isNaN(createdMs)) return false;
  return Math.abs(rowMs - createdMs) <= WINDOW_MS;
}

function refContains(reference: string, needle: string): boolean {
  const haystack = reference.toLowerCase().replace(/\s+/g, '');
  if (!haystack || !needle) return false;
  return haystack.includes(needle.toLowerCase().replace(/\s+/g, ''));
}

/** Normalize a bank reference only for exact comparisons. */
export function normalizeBankReference(reference: string | null | undefined): string {
  return (reference ?? '').trim().replace(/\s+/g, '').toUpperCase();
}

/** Exact (case/spacing-insensitive) reference match, never a substring match. */
export function bankReferenceMatches(
  actual: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const normalizedActual = normalizeBankReference(actual);
  const normalizedExpected = normalizeBankReference(expected);
  return normalizedActual.length > 0 && normalizedActual === normalizedExpected;
}

function currenciesMatch(row: ParsedBankRow, payment: PendingBankPayment): boolean {
  if (!row.currency || !payment.currency) return true;
  return row.currency.trim().toUpperCase() === payment.currency.trim().toUpperCase();
}

function confidenceOf(
  row: ParsedBankRow,
  payment: PendingBankPayment,
): BankMatchConfidence {
  const near = withinWindow(row.dateIso, payment.createdAtIso);
  if (!near) return 'low';
  const refHit =
    (payment.expectedReference
      ? bankReferenceMatches(row.reference, payment.expectedReference)
      : false) ||
    refContains(row.reference, payment.paymentId) ||
    refContains(row.reference, payment.unitLabel);
  return refHit ? 'high' : 'medium';
}

/**
 * Greedy one-to-one matcher between statement rows and pending orders.
 * Candidates are ranked high → medium → low; each row and each order is
 * used at most once. Rows without a usable candidate get no suggestion entry.
 */
export function suggestMatches(
  rows: ParsedBankRow[],
  pendingPayments: PendingBankPayment[],
): BankMatchSuggestionDto[] {
  interface Candidate {
    rowIndex: number;
    paymentIndex: number;
    confidence: BankMatchConfidence;
  }

  const candidates: Candidate[] = [];
  rows.forEach((row, rowIndex) => {
    if (row.amountCents <= 0) return;
    pendingPayments.forEach((payment, paymentIndex) => {
      if (payment.amountCents !== row.amountCents) return;
      if (!currenciesMatch(row, payment)) return;
      candidates.push({
        rowIndex,
        paymentIndex,
        confidence: confidenceOf(row, payment),
      });
    });
  });

  candidates.sort(
    (a, b) =>
      RANK[a.confidence] - RANK[b.confidence] ||
      a.rowIndex - b.rowIndex ||
      a.paymentIndex - b.paymentIndex,
  );

  const takenRows = new Set<number>();
  const takenPayments = new Set<number>();
  const suggestions: BankMatchSuggestionDto[] = [];
  for (const c of candidates) {
    if (takenRows.has(c.rowIndex) || takenPayments.has(c.paymentIndex)) {
      continue;
    }
    takenRows.add(c.rowIndex);
    takenPayments.add(c.paymentIndex);
    suggestions.push({
      rowIndex: c.rowIndex,
      paymentId: pendingPayments[c.paymentIndex].paymentId,
      confidence: c.confidence,
    });
  }
  return suggestions.sort((a, b) => a.rowIndex - b.rowIndex);
}
