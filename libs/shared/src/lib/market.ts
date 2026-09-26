/**
 * Market registry — the configuration that makes PolykatoikiaOS sellable in
 * Greece (default) and abroad. Each market groups the regional currency,
 * default payment provider / rails, default number locale, primary languages,
 * and e-invoice compliance. Building market codes match the Prisma `market`
 * column and are synthetic region codes, not free text.
 */

import {
  CURRENCY_CODES,
  type CurrencyCode,
} from './money';

export type { CurrencyCode } from './money';
export { CURRENCY_CODES, DEFAULT_CURRENCY, isCurrencyCode } from './money';

export type MarketCode =
  | 'GR'
  | 'EU'
  | 'US'
  | 'CA'
  | 'MX'
  | 'BR'
  | 'AR'
  | 'CL'
  | 'CO'
  | 'PE'
  | 'JP';

/** Building-level PSP selection. `viva` is the Greek default. */
export const PSP_PROVIDERS = [
  'viva',
  'stripejp',
  'stripe',
  'mercadopago',
  'gmo',
] as const;
export type PspProvider = (typeof PSP_PROVIDERS)[number];

export interface MarketProfile {
  /** Region code used in the DB (`Building.market`). */
  market: MarketCode;
  /** Default ISO-4217 currency for buildings in this market. */
  currency: CurrencyCode;
  /** Default provider resolved when Building.pspProvider is unset. */
  pspProvider: PspProvider;
  /** Currencies accepted for this market (default is always first). */
  currencies: readonly CurrencyCode[];
  /** Providers accepted for this market (default is always first). */
  pspProviders: readonly PspProvider[];
  /** BCP47 number/date locale used for default formatting. */
  locale: string;
  /** Primary UI languages offered to users in this market. */
  languages: readonly string[];
  /** E-invoice compliance adapter key. `mydata` only applies to GR. */
  eInvoice: string;
}

/** Canonical list — order matters for dropdowns/docs, not for behavior. */
export const MARKET_CODES: MarketCode[] = [
  'GR', 'EU', 'US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'JP',
];

export const DEFAULT_MARKET: MarketCode = 'GR';

const CURRENCIES_BY_MARKET: Record<MarketCode, readonly CurrencyCode[]> = {
  GR: ['EUR'],
  EU: ['EUR', 'GBP', 'PLN', 'SEK', 'CZK'],
  US: ['USD'],
  CA: ['CAD'],
  MX: ['MXN'],
  BR: ['BRL'],
  AR: ['ARS'],
  CL: ['CLP'],
  CO: ['COP'],
  PE: ['PEN'],
  JP: ['JPY'],
};

const PROVIDERS_BY_MARKET: Record<MarketCode, readonly PspProvider[]> = {
  GR: ['viva'],
  EU: ['stripe'],
  US: ['stripe'],
  CA: ['stripe'],
  // Mercado Pago is the default local rail; Stripe remains a supported
  // fallback in the markets where the global adapter is available.
  MX: ['mercadopago', 'stripe'],
  BR: ['mercadopago', 'stripe'],
  AR: ['mercadopago', 'stripe'],
  CL: ['mercadopago', 'stripe'],
  CO: ['mercadopago', 'stripe'],
  PE: ['mercadopago', 'stripe'],
  JP: ['stripejp', 'gmo'],
};

/**
 * Single source of truth for per-market regional defaults. Greece is the
 * zero-configuration baseline; every other market opts in per building.
 */
export const MARKET_REGISTRY: Record<MarketCode, MarketProfile> = {
  GR: {
    market: 'GR',
    currency: 'EUR',
    pspProvider: 'viva',
    currencies: CURRENCIES_BY_MARKET.GR,
    pspProviders: PROVIDERS_BY_MARKET.GR,
    locale: 'el-GR',
    languages: ['el'],
    eInvoice: 'mydata',
  },
  EU: {
    market: 'EU',
    currency: 'EUR',
    pspProvider: 'stripe',
    currencies: CURRENCIES_BY_MARKET.EU,
    pspProviders: PROVIDERS_BY_MARKET.EU,
    locale: 'en-GB',
    languages: ['en', 'de', 'fr', 'es', 'it', 'pt'],
    eInvoice: 'vat-memo',
  },
  US: {
    market: 'US',
    currency: 'USD',
    pspProvider: 'stripe',
    currencies: CURRENCIES_BY_MARKET.US,
    pspProviders: PROVIDERS_BY_MARKET.US,
    locale: 'en-US',
    languages: ['en'],
    eInvoice: 'sales-memo',
  },
  CA: {
    market: 'CA',
    currency: 'CAD',
    pspProvider: 'stripe',
    currencies: CURRENCIES_BY_MARKET.CA,
    pspProviders: PROVIDERS_BY_MARKET.CA,
    locale: 'en-CA',
    languages: ['en', 'fr'],
    eInvoice: 'vat-memo',
  },
  MX: {
    market: 'MX',
    currency: 'MXN',
    pspProvider: 'mercadopago',
    currencies: CURRENCIES_BY_MARKET.MX,
    pspProviders: PROVIDERS_BY_MARKET.MX,
    locale: 'es-MX',
    languages: ['es'],
    eInvoice: 'cfdi',
  },
  BR: {
    market: 'BR',
    currency: 'BRL',
    pspProvider: 'mercadopago',
    currencies: CURRENCIES_BY_MARKET.BR,
    pspProviders: PROVIDERS_BY_MARKET.BR,
    locale: 'pt-BR',
    languages: ['pt'],
    eInvoice: 'nfe',
  },
  AR: {
    market: 'AR',
    currency: 'ARS',
    pspProvider: 'mercadopago',
    currencies: CURRENCIES_BY_MARKET.AR,
    pspProviders: PROVIDERS_BY_MARKET.AR,
    locale: 'es-AR',
    languages: ['es'],
    eInvoice: 'vat-memo',
  },
  CL: {
    market: 'CL',
    currency: 'CLP',
    pspProvider: 'mercadopago',
    currencies: CURRENCIES_BY_MARKET.CL,
    pspProviders: PROVIDERS_BY_MARKET.CL,
    locale: 'es-CL',
    languages: ['es'],
    eInvoice: 'vyes',
  },
  CO: {
    market: 'CO',
    currency: 'COP',
    pspProvider: 'mercadopago',
    currencies: CURRENCIES_BY_MARKET.CO,
    pspProviders: PROVIDERS_BY_MARKET.CO,
    locale: 'es-CO',
    languages: ['es'],
    eInvoice: 'vat-memo',
  },
  PE: {
    market: 'PE',
    currency: 'PEN',
    pspProvider: 'mercadopago',
    currencies: CURRENCIES_BY_MARKET.PE,
    pspProviders: PROVIDERS_BY_MARKET.PE,
    locale: 'es-PE',
    languages: ['es'],
    eInvoice: 'vat-memo',
  },
  JP: {
    market: 'JP',
    currency: 'JPY',
    pspProvider: 'stripejp',
    currencies: CURRENCIES_BY_MARKET.JP,
    pspProviders: PROVIDERS_BY_MARKET.JP,
    locale: 'ja-JP',
    languages: ['ja'],
    // The qualified-invoice field is present, but a live JP filing adapter is
    // intentionally not claimed by this registry.
    eInvoice: 'jp-qualified-invoice',
  },
};

/** Currency/provider capabilities used for cross-field validation. */
export const PSP_CURRENCIES: Readonly<Record<PspProvider, readonly CurrencyCode[]>> = {
  viva: ['EUR'],
  stripe: ['EUR', 'USD', 'CAD', 'MXN', 'BRL', 'ARS', 'CLP', 'COP', 'PEN', 'GBP', 'PLN', 'SEK', 'CZK'],
  mercadopago: ['BRL', 'ARS', 'CLP', 'COP', 'PEN', 'MXN'],
  stripejp: ['JPY'],
  gmo: ['JPY'],
};

/** True when a market profile exists (defensive). */
export function isMarketCode(value: unknown): value is MarketCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(MARKET_REGISTRY, value)
  );
}

export function isCurrencySupportedByMarket(
  market: string,
  currency: string,
): boolean {
  if (!isMarketCode(market)) return false;
  return MARKET_REGISTRY[market].currencies.includes(currency as CurrencyCode);
}

export const isMarketCurrencyCompatible = isCurrencySupportedByMarket;

export function isPspSupportedByMarket(
  market: string,
  provider: string,
): boolean {
  if (!isMarketCode(market)) return false;
  return MARKET_REGISTRY[market].pspProviders.includes(provider as PspProvider);
}

export const isMarketProviderCompatible = isPspSupportedByMarket;

export function isCurrencySupportedByProvider(
  provider: string,
  currency: string,
): boolean {
  return (
    (Object.prototype.hasOwnProperty.call(PSP_CURRENCIES, provider) as boolean) &&
    PSP_CURRENCIES[provider as PspProvider].includes(currency as CurrencyCode)
  );
}

/** Resolve a market to its profile, falling back to Greece for display code. */
export function resolveMarket(market: string | null | undefined): MarketProfile {
  if (market && isMarketCode(market)) {
    return MARKET_REGISTRY[market];
  }
  return MARKET_REGISTRY.GR;
}

export function requireMarket(market: string): MarketProfile {
  if (!isMarketCode(market)) {
    throw new Error(`Unknown market code: ${market}`);
  }
  return MARKET_REGISTRY[market];
}

/** Default currency for a market code (falls back to EUR for legacy data). */
export function marketCurrency(
  market: string | null | undefined,
): CurrencyCode {
  return resolveMarket(market).currency;
}

export function marketCurrencies(
  market: string | null | undefined,
): readonly CurrencyCode[] {
  return resolveMarket(market).currencies;
}

export function marketPspProviders(
  market: string | null | undefined,
): readonly PspProvider[] {
  return resolveMarket(market).pspProviders;
}

export class MarketSettingsValidationError extends Error {
  readonly code = 'INVALID_MARKET_SETTINGS';

  constructor(message: string) {
    super(message);
    this.name = 'MarketSettingsValidationError';
  }
}

export interface MarketSettingsInput {
  market: string;
  currency: string;
  pspProvider: string;
}

export interface ValidatedMarketSettings {
  market: MarketCode;
  currency: CurrencyCode;
  pspProvider: PspProvider;
}

/**
 * Validate the complete market/currency/provider tuple.  Callers should pass
 * the effective values (existing values merged with a partial PATCH), not
 * just the fields present in a request, so a partial update cannot create an
 * impossible combination.
 */
export function validateMarketSettings(
  input: MarketSettingsInput,
): ValidatedMarketSettings {
  if (!input || typeof input !== 'object') {
    throw new MarketSettingsValidationError('Market settings are required');
  }
  if (!isMarketCode(input.market)) {
    throw new MarketSettingsValidationError(`Unknown market: ${input.market}`);
  }
  if (!CURRENCY_CODES.includes(input.currency as CurrencyCode)) {
    throw new MarketSettingsValidationError(
      `Unknown currency: ${input.currency}`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(PSP_CURRENCIES, input.pspProvider)) {
    throw new MarketSettingsValidationError(
      `Unknown payment provider: ${input.pspProvider}`,
    );
  }
  if (!isCurrencySupportedByMarket(input.market, input.currency)) {
    throw new MarketSettingsValidationError(
      `Currency ${input.currency} is not supported in market ${input.market}`,
    );
  }
  if (!isPspSupportedByMarket(input.market, input.pspProvider)) {
    throw new MarketSettingsValidationError(
      `Payment provider ${input.pspProvider} is not supported in market ${input.market}`,
    );
  }
  if (!isCurrencySupportedByProvider(input.pspProvider, input.currency)) {
    throw new MarketSettingsValidationError(
      `Payment provider ${input.pspProvider} does not support ${input.currency}`,
    );
  }
  return {
    market: input.market,
    currency: input.currency as CurrencyCode,
    pspProvider: input.pspProvider as PspProvider,
  };
}

export const assertMarketSettings = validateMarketSettings;
export const validateMarketCurrencyProvider = validateMarketSettings;
export const isMarketCurrencyProviderCompatible = (
  market: string,
  currency: string,
  pspProvider: string,
): boolean => {
  try {
    validateMarketSettings({ market, currency, pspProvider });
    return true;
  } catch {
    return false;
  }
};

export function assertMarketCurrencyCompatible(
  market: string,
  currency: string,
): void {
  if (!isCurrencySupportedByMarket(market, currency)) {
    throw new MarketSettingsValidationError(
      `Currency ${currency} is not supported in market ${market}`,
    );
  }
}

export function assertMarketProviderCompatible(
  market: string,
  provider: string,
): void {
  if (!isPspSupportedByMarket(market, provider)) {
    throw new MarketSettingsValidationError(
      `Payment provider ${provider} is not supported in market ${market}`,
    );
  }
}