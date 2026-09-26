const PERIOD_REGEX = /^(\d{4})-(0[1-9]|1[0-2])$/;

export class InvalidPeriodError extends Error {
  readonly code = 'INVALID_PERIOD';

  constructor(value: unknown) {
    super(`invalid period "${String(value)}", expected YYYY-MM`);
    this.name = 'InvalidPeriodError';
  }
}

/** Returns `true` when `value` matches `YYYY-MM` with a valid month/year. */
export function isValidPeriod(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = PERIOD_REGEX.exec(value);
  return Boolean(match && Number(match[1]) >= 1);
}

/** Formats a date as `YYYY-MM` in UTC. */
export function formatPeriod(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError('formatPeriod requires a valid Date');
  }
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) {
    throw new RangeError('period year must be between 0001 and 9999');
  }
  return `${String(year).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Parses `YYYY-MM` into `{ year, month }` (month is 1-based). Throws on invalid input. */
export function parsePeriod(value: unknown): { year: number; month: number } {
  if (!isValidPeriod(value)) {
    throw new InvalidPeriodError(value);
  }
  const [year, month] = value.split('-').map(Number);
  return { year, month };
}

export function assertValidPeriod(value: unknown): string {
  parsePeriod(value);
  if (typeof value !== 'string') {
    throw new InvalidPeriodError(value);
  }
  return value;
}

/** Returns the next period after `value` (`2025-12` → `2026-01`). */
export function nextPeriod(value: string): string {
  const { year, month } = parsePeriod(value);
  if (year === 9999 && month === 12) {
    throw new RangeError('cannot advance beyond 9999-12');
  }
  return month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, '0')}`;
}

/** Returns the previous period (`2026-01` → `2025-12`). */
export function previousPeriod(value: string): string {
  const { year, month } = parsePeriod(value);
  if (year === 1 && month === 1) {
    throw new RangeError('cannot move before 0001-01');
  }
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/** Add a signed number of months to a period. */
export function addPeriods(value: string, amount: number): string {
  if (!Number.isSafeInteger(amount)) {
    throw new TypeError('period offset must be a safe integer');
  }
  const { year, month } = parsePeriod(value);
  const zeroBased = year * 12 + (month - 1) + amount;
  if (zeroBased < 12 || zeroBased > 9999 * 12 + 11) {
    throw new RangeError('period result is outside 0001-01..9999-12');
  }
  const resultYear = Math.floor(zeroBased / 12);
  const resultMonth = (zeroBased % 12) + 1;
  return `${String(resultYear).padStart(4, '0')}-${String(resultMonth).padStart(2, '0')}`;
}

/** Compare two periods chronologically: -1, 0, or 1. */
export function comparePeriods(left: string, right: string): -1 | 0 | 1 {
  const a = parsePeriod(left);
  const b = parsePeriod(right);
  return a.year === b.year && a.month === b.month
    ? 0
    : a.year < b.year || (a.year === b.year && a.month < b.month)
      ? -1
      : 1;
}

/** First UTC instant in the period. */
export function periodStart(value: string): Date {
  const { year, month } = parsePeriod(value);
  return new Date(Date.UTC(year, month - 1, 1));
}

/** Exclusive first instant of the following period. */
export function periodEnd(value: string): Date {
  const { year, month } = parsePeriod(value);
  // Date.UTC supports years beyond 9999, so the exclusive end of the final
  // representable period remains mathematically correct.
  return year === 9999 && month === 12
    ? new Date(Date.UTC(10000, 0, 1))
    : periodStart(nextPeriod(value));
}

/**
 * Inclusive period range.  The upper bound is deliberately bounded to avoid
 * an accidental request turning into an unbounded allocation of memory.
 */
export function periodRange(start: string, end: string, maxItems = 1200): string[] {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new TypeError('maxItems must be a positive safe integer');
  }
  if (comparePeriods(start, end) > 0) {
    throw new RangeError('period range start must not be after end');
  }
  const result: string[] = [];
  let cursor = start;
  while (comparePeriods(cursor, end) <= 0) {
    result.push(cursor);
    if (result.length > maxItems) {
      throw new RangeError(`period range exceeds ${maxItems} items`);
    }
    if (cursor === end) break;
    cursor = nextPeriod(cursor);
  }
  return result;
}

export function isPeriodInRange(
  value: string,
  start: string,
  end: string,
): boolean {
  return comparePeriods(value, start) >= 0 && comparePeriods(value, end) <= 0;
}

export const isPeriodBetween = isPeriodInRange;

export const periodToStartDate = periodStart;
export const periodToEndDate = periodEnd;
