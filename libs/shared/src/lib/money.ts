/**
 * Currency-aware money primitives.
 *
 * Amounts in the domain are integer minor units (the historical `*Cents`
 * fields are kept for compatibility with the API).  Not every ISO-4217
 * currency has two decimal places, so callers must not divide every amount by
 * 100.  This module is deliberately dependency-free so it can be used by the
 * API, the web client, and background jobs alike.
 */

export const CURRENCY_CODES = [
  'EUR',
  'USD',
  'CAD',
  'MXN',
  'BRL',
  'ARS',
  'CLP',
  'COP',
  'PEN',
  'GBP',
  'PLN',
  'SEK',
  'CZK',
  'JPY',
] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export interface CurrencyDefinition {
  readonly code: CurrencyCode;
  /** Number of digits after the decimal separator in the major unit. */
  readonly minorUnitDigits: number;
  /** ISO 4217 numeric code, useful at provider/export boundaries. */
  readonly numericCode: string;
}

/**
 * Supported currencies and their minor-unit precision.  The list is
 * intentionally explicit: accepting an arbitrary three-letter string makes
 * it far too easy to accidentally format a value as the wrong currency.
 */
export const CURRENCY_DEFINITIONS: Readonly<
  Record<CurrencyCode, CurrencyDefinition>
> = {
  EUR: { code: 'EUR', minorUnitDigits: 2, numericCode: '978' },
  USD: { code: 'USD', minorUnitDigits: 2, numericCode: '840' },
  CAD: { code: 'CAD', minorUnitDigits: 2, numericCode: '124' },
  MXN: { code: 'MXN', minorUnitDigits: 2, numericCode: '484' },
  BRL: { code: 'BRL', minorUnitDigits: 2, numericCode: '986' },
  ARS: { code: 'ARS', minorUnitDigits: 2, numericCode: '032' },
  CLP: { code: 'CLP', minorUnitDigits: 0, numericCode: '152' },
  COP: { code: 'COP', minorUnitDigits: 0, numericCode: '170' },
  PEN: { code: 'PEN', minorUnitDigits: 2, numericCode: '604' },
  GBP: { code: 'GBP', minorUnitDigits: 2, numericCode: '826' },
  PLN: { code: 'PLN', minorUnitDigits: 2, numericCode: '985' },
  SEK: { code: 'SEK', minorUnitDigits: 2, numericCode: '752' },
  CZK: { code: 'CZK', minorUnitDigits: 2, numericCode: '203' },
  JPY: { code: 'JPY', minorUnitDigits: 0, numericCode: '392' },
};

/** Alias kept intentionally descriptive for callers that prefer the term. */
export const CURRENCY_MINOR_UNITS: Readonly<Record<CurrencyCode, number>> =
  Object.freeze(
    Object.fromEntries(
      CURRENCY_CODES.map((currency) => [
        currency,
        CURRENCY_DEFINITIONS[currency].minorUnitDigits,
      ]),
    ) as Record<CurrencyCode, number>,
  );

/** Naming aliases for consumers that use “exponent” terminology. */
export const CURRENCY_MINOR_UNIT_DIGITS = CURRENCY_MINOR_UNITS;
export const MINOR_UNIT_EXPONENTS = CURRENCY_MINOR_UNITS;
export const CURRENCY_MINOR_UNIT_FACTORS: Readonly<
  Record<CurrencyCode, number>
> = Object.freeze(
  Object.fromEntries(
    CURRENCY_CODES.map((currency) => [
      currency,
      10 ** CURRENCY_DEFINITIONS[currency].minorUnitDigits,
    ]),
  ) as Record<CurrencyCode, number>,
);
export const MINOR_UNIT_FACTORS = CURRENCY_MINOR_UNIT_FACTORS;
export const CURRENCIES = CURRENCY_CODES;

export const DEFAULT_CURRENCY: CurrencyCode = 'EUR';
export const DEFAULT_MONEY_LOCALE = 'el-GR';

export class InvalidCurrencyError extends Error {
  readonly code = 'INVALID_CURRENCY';

  constructor(value: unknown) {
    super(`Invalid or unsupported currency: ${String(value)}`);
    this.name = 'InvalidCurrencyError';
  }
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return (
    typeof value === 'string' &&
    (CURRENCY_CODES as readonly string[]).includes(value)
  );
}

export function assertCurrencyCode(
  value: unknown,
): asserts value is CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new InvalidCurrencyError(value);
  }
}

export function getCurrencyDefinition(currency: string): CurrencyDefinition {
  assertCurrencyCode(currency);
  return CURRENCY_DEFINITIONS[currency];
}

/** Number of minor-unit digits used by a currency (CLP/COP/JPY => 0). */
export function getCurrencyMinorUnitDigits(currency: string): number {
  return getCurrencyDefinition(currency).minorUnitDigits;
}

/** Short alias for {@link getCurrencyMinorUnitDigits}. */
export const currencyMinorUnitDigits = getCurrencyMinorUnitDigits;
export const getMinorUnitDigits = getCurrencyMinorUnitDigits;
export const getCurrencyMinorUnits = getCurrencyMinorUnitDigits;

export function currencyMinorUnitFactor(currency: string): number {
  return 10 ** getCurrencyMinorUnitDigits(currency);
}

function assertMinorUnits(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError('Money minor units must be a safe integer');
  }
}

/**
 * Convert integer minor units to a major-unit number for formatting or a
 * provider boundary.  This function is for display/transport only; accounting
 * arithmetic should continue to use integers.
 */
export function minorUnitsToMajor(
  minorUnits: number,
  currency: string = DEFAULT_CURRENCY,
): number {
  assertCurrencyCode(currency);
  assertMinorUnits(minorUnits);
  return minorUnits / currencyMinorUnitFactor(currency);
}

export const toMajorUnits = minorUnitsToMajor;

/**
 * Convert a decimal major-unit value to integer minor units without silently
 * changing precision.  Floating-point input is accepted only when it can be
 * represented exactly at the currency's supported precision; callers that need
 * financial parsing should generally pass a decimal string.
 */
export function majorUnitsToMinor(
  majorUnits: number,
  currency: string = DEFAULT_CURRENCY,
): number {
  assertCurrencyCode(currency);
  if (!Number.isFinite(majorUnits)) {
    throw new TypeError('Money amount must be finite');
  }
  const digits = getCurrencyMinorUnitDigits(currency);
  const factor = 10 ** digits;
  const scaled = majorUnits * factor;
  if (
    !Number.isSafeInteger(scaled) ||
    Math.abs(scaled - Math.round(scaled)) > Number.EPSILON * Math.max(1, Math.abs(scaled))
  ) {
    throw new RangeError(
      `Amount has more than ${digits} decimal places for ${currency}`,
    );
  }
  assertMinorUnits(Math.round(scaled));
  return Math.round(scaled);
}

export const toMinorUnits = majorUnitsToMinor;

interface DecimalParts {
  negative: boolean;
  integer: string;
  fraction: string;
}

/**
 * Parse a human decimal amount without `parseFloat` surprises.  Both
 * `1,234.56` and `1.234,56` are accepted; when both separators occur, the
 * right-most one is treated as the decimal separator.  Grouping-only strings
 * such as `1,234` are interpreted according to the normal decimal grammar
 * (one thousand two hundred thirty-four), not as 1.234 major units.
 */
function decimalParts(value: string): DecimalParts {
  const text = value.trim();
  if (!text || !/^[+-]?(?:\d[\d.,]*|[.,]\d+)$/.test(text)) {
    throw new TypeError(`Invalid money amount: ${value}`);
  }

  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[+-]/, '');
  if (/[.,]{2,}/.test(unsigned) || unsigned.endsWith(',')) {
    throw new TypeError(`Invalid money amount: ${value}`);
  }
  const lastComma = unsigned.lastIndexOf(',');
  const lastDot = unsigned.lastIndexOf('.');
  const decimalAt = Math.max(lastComma, lastDot);
  let integer = decimalAt < 0 ? unsigned : unsigned.slice(0, decimalAt);
  let fraction = decimalAt < 0 ? '' : unsigned.slice(decimalAt + 1);

  if (decimalAt >= 0 && lastComma >= 0 && lastDot >= 0) {
    // The right-most separator is the decimal point; all earlier separators
    // are grouping marks (`1.234,56` or `1,234.56`).
    integer = unsigned.slice(0, decimalAt).replace(/[.,]/g, '');
    fraction = unsigned.slice(decimalAt + 1);
  } else if (decimalAt >= 0) {
    const separator = decimalAt === lastComma ? ',' : '.';
    // A single separator followed by exactly three digits is conventionally
    // a grouping mark (1,234), unless the caller explicitly supplied a
    // decimal separator through a leading/trailing pattern such as `,50`.
    const digitsAfter = unsigned.length - decimalAt - 1;
    if (
      digitsAfter === 3 &&
      integer.length > 0 &&
      !unsigned.startsWith(separator) &&
      !unsigned.endsWith(separator)
    ) {
      integer = unsigned.replace(/[.,]/g, '');
      fraction = '';
    }
  }

  integer = integer.replace(/[.,]/g, '') || '0';
  fraction = fraction.replace(/[.,]/g, '');
  if (!/^\d+$/.test(integer) || !/^\d*$/.test(fraction)) {
    throw new TypeError(`Invalid money amount: ${value}`);
  }
  return { negative, integer, fraction };
}

/**
 * Parse a decimal amount into safe integer minor units.  Extra decimal places
 * are rejected instead of rounded, preventing a user/operator from changing a
 * payable amount during import.
 */
export function parseMoney(
  value: string | number,
  currency: string = DEFAULT_CURRENCY,
): number {
  assertCurrencyCode(currency);
  const digits = getCurrencyMinorUnitDigits(currency);
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Money amount must be finite');
    text = value.toString();
    // Do not silently round exponential notation (for example 1e-7) at a
    // payment boundary. Callers can pass an explicit decimal string instead.
    if (/[eE]/.test(text)) {
      throw new RangeError('Exponential money amounts are not accepted');
    }
  } else {
    text = value;
  }

  const parts = decimalParts(text);
  if (parts.fraction.length > digits) {
    throw new RangeError(
      `Amount has ${parts.fraction.length} decimal places; ${currency} supports ${digits}`,
    );
  }
  const padded = parts.fraction.padEnd(digits, '0');
  const magnitude = BigInt(`${parts.integer}${padded || ''}`);
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Money amount is outside the safe integer range');
  }
  const signed = parts.negative ? -magnitude : magnitude;
  const result = Number(signed);
  assertMinorUnits(result);
  return result;
}

export const parseMoneyToMinorUnits = parseMoney;
export const moneyToMinorUnits = parseMoney;

export interface FormatMoneyOptions {
  currency?: string;
  locale?: string;
  /** Optional display name; useful for exports that do not want a symbol. */
  currencyDisplay?: 'code' | 'symbol' | 'narrowSymbol' | 'name';
}

/**
 * Format integer minor units using the currency's actual precision.  CLP,
 * COP, and JPY therefore render without a fabricated `.00`; EUR/USD/etc. keep
 * two fraction digits.  Invalid currencies are surfaced to the caller rather
 * than silently falling back to euros.
 */
export function formatMoney(
  minorUnits: number,
  options: FormatMoneyOptions | string = {},
  legacyLocale?: string,
): string {
  const opts: FormatMoneyOptions =
    typeof options === 'string' ? { currency: options, locale: legacyLocale } : options;
  const currency = opts.currency ?? DEFAULT_CURRENCY;
  const locale = opts.locale ?? DEFAULT_MONEY_LOCALE;
  assertCurrencyCode(currency);
  assertMinorUnits(minorUnits);
  if (typeof locale !== 'string' || locale.trim() === '') {
    throw new TypeError('Money locale must be a non-empty string');
  }
  const digits = getCurrencyMinorUnitDigits(currency);
  const major = minorUnits / currencyMinorUnitFactor(currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: opts.currencyDisplay ?? 'symbol',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(major);
}

export const formatMinorUnits = formatMoney;

/** Legacy EUR helper retained byte-for-byte for Greek call sites. */
export function formatEuros(minorUnits: number): string {
  assertCurrencyCode('EUR');
  assertMinorUnits(minorUnits);
  return `${(minorUnits / 100).toLocaleString('el-GR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}
