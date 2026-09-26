/**
 * Small, dependency-free payment safety helpers.
 *
 * Payment providers are deliberately fail-closed.  A missing live credential is
 * an error unless the process has explicitly opted into the local mock mode.
 * `NODE_ENV=test` (or an unset NODE_ENV) is not, by itself, permission to use a
 * fake PSP.
 */

export type PaymentProvider =
  | 'viva'
  | 'stripe'
  | 'stripejp'
  | 'mercadopago'
  | 'gmo';

export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV?.trim().toLowerCase() === 'production';
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

/**
 * Mocks are an explicit local-development escape hatch.  Several names are
 * accepted because deployments already use slightly different names for
 * local PSP settings; all of them are opt-in and none are honoured in
 * production.
 */
export function isMockPaymentsEnabled(): boolean {
  if (isProductionEnvironment()) return false;
  return [
    process.env.PAYMENTS_MOCK_MODE,
    process.env.PAYMENT_MOCK_MODE,
    process.env.PSP_MOCK_MODE,
    process.env.MOCK_PAYMENTS,
    process.env.MOCK_PAYMENTS_ENABLED,
    process.env.PAYMENTS_MOCK,
    process.env.USE_MOCK_PAYMENTS,
    process.env.USE_MOCK_ADAPTERS,
    process.env.ALLOW_MOCK_ADAPTERS,
    process.env.PSP_MOCK,
    process.env.MOCK_MODE,
    process.env.ALLOW_MOCK_PAYMENTS,
  ].some(isTruthy);
}

export function hasLiveConfig(...values: Array<string | undefined>): boolean {
  return values.every((value) => typeof value === 'string' && value.trim().length > 0);
}

export function normalizeCurrency(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

export function normalizeProvider(
  value: string | null | undefined,
): PaymentProvider | null {
  if (value === null || value === undefined) return 'viva';
  if (typeof value !== 'string') return null;
  if (value.trim() === '') return 'viva';
  switch (value.trim().toLowerCase()) {
    case 'viva':
      return 'viva';
    case 'stripe':
      return 'stripe';
    case 'stripejp':
    case 'stripe-jp':
      return 'stripejp';
    case 'mercadopago':
    case 'mercado-pago':
    case 'mercado_pago':
      return 'mercadopago';
    case 'gmo':
      return 'gmo';
    default:
      return null;
  }
}

/** Throw at the service boundary if a mock adapter was injected by mistake. */
export function assertLiveAdapter(adapter: unknown, provider: string): void {
  const candidate = adapter as
    | { isMock?: boolean; isAvailable?: boolean }
    | null
    | undefined;
  if (
    isProductionEnvironment() &&
    (candidate?.isMock !== false || candidate?.isAvailable !== true)
  ) {
    throw new Error(`The ${provider} adapter is not a verified live adapter`);
  }
  if (candidate?.isMock && !isMockPaymentsEnabled()) {
    throw new Error(
      `Mock ${provider} adapter is disabled; set an explicit non-production mock flag to use it`,
    );
  }
}
