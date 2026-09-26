/**
 * Startup security configuration.
 *
 * This module is deliberately free of Nest/Prisma imports so it can be
 * exercised by unit tests before the application is bootstrapped.
 */

export const MIN_JWT_SECRET_LENGTH = 32;

export const DEFAULT_JWT_SECRETS = new Set([
  'change-me',
  'change-me-too',
  'dev-only-two-factor-ticket-secret',
  'secret',
  'replace-me',
]);

const TWO_FACTOR_SECRET_NAMES = [
  'JWT_2FA_SECRET',
  'TWO_FACTOR_TICKET_SECRET',
  'JWT_TWO_FACTOR_SECRET',
  'TWO_FACTOR_JWT_SECRET',
  'JWT_2FA_TICKET_SECRET',
  'TWO_FACTOR_SECRET',
] as const;

function envValue(env: NodeJS.ProcessEnv, names: readonly string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return '';
}

/** The dedicated 2FA ticket key, with a compatibility alias for old deploys. */
export function getTwoFactorSecret(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return envValue(env, TWO_FACTOR_SECRET_NAMES);
}

export function getCorsOriginValues(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function isWeakSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length < MIN_JWT_SECRET_LENGTH) return true;
  if (DEFAULT_JWT_SECRETS.has(normalized)) return true;
  if (/^(.)\1+$/.test(normalized)) return true;
  // A real random/base64/hex key should not be made of only a handful of
  // repeated characters. This catches common placeholder values while still
  // allowing all valid hexadecimal and base64 alphabets.
  if (new Set(normalized).size < 8) return true;
  return false;
}

function validateOrigin(origin: string): void {
  if (origin === '*' || origin.includes('*')) {
    throw new Error('CORS_ORIGINS must not contain a wildcard in production');
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`CORS_ORIGINS contains an invalid origin: ${origin}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`CORS_ORIGINS contains an unsupported origin: ${origin}`);
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`CORS_ORIGINS must contain origins only: ${origin}`);
  }
}

/**
 * Validate configuration that must never fall back to development defaults
 * in a production process. The function is idempotent and throws a concise
 * Error so bootstrap fails before any request can be served.
 */
export function validateProductionConfig(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== 'production') return;

  const accessSecret = env.JWT_ACCESS_SECRET?.trim() ?? '';
  const refreshSecret = env.JWT_REFRESH_SECRET?.trim() ?? '';
  // Production requires a dedicated key. Legacy dedicated aliases remain
  // accepted for rolling deployments; the old generic JWT_SECRET does not.
  const twoFactorSecret =
    env.JWT_2FA_SECRET?.trim() ||
    env.TWO_FACTOR_TICKET_SECRET?.trim() ||
    env.JWT_TWO_FACTOR_SECRET?.trim() ||
    env.TWO_FACTOR_JWT_SECRET?.trim() ||
    env.JWT_2FA_TICKET_SECRET?.trim() ||
    env.TWO_FACTOR_SECRET?.trim() ||
    '';

  for (const [name, value] of [
    ['JWT_ACCESS_SECRET', accessSecret],
    ['JWT_REFRESH_SECRET', refreshSecret],
    ['JWT_2FA_SECRET', twoFactorSecret],
  ] as const) {
    if (!value) {
      throw new Error(`${name} must be configured in production`);
    }
    if (isWeakSecret(value)) {
      throw new Error(
        `${name} must be a strong secret of at least ${MIN_JWT_SECRET_LENGTH} characters`,
      );
    }
  }

  if (
    accessSecret === refreshSecret ||
    accessSecret === twoFactorSecret ||
    refreshSecret === twoFactorSecret
  ) {
    throw new Error('JWT access, refresh, and 2FA secrets must be distinct');
  }

  const origins = getCorsOriginValues(env);
  if (origins.length === 0) {
    throw new Error('CORS_ORIGINS must be configured in production');
  }
  origins.forEach(validateOrigin);
}

/** Alias useful to callers that prefer an assertion-style name. */
export const assertProductionConfig = validateProductionConfig;
export const validateSecurityConfig = validateProductionConfig;
export const validateStartupConfig = validateProductionConfig;

/**
 * CORS setting used by Nest. Development intentionally keeps the convenient
 * open default; production is forced through validateProductionConfig first.
 */
export function corsOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] | boolean {
  const origins = getCorsOriginValues(env);
  if (origins.length === 0) return env.NODE_ENV === 'production' ? false : true;
  return origins;
}

/**
 * Cookie-authenticated state-changing requests are same-site protected, and
 * this check additionally rejects an explicitly cross-site browser origin.
 * Requests without Origin/Referer are left to SameSite/non-browser clients.
 */
export function isAllowedAuthOrigin(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!origin) return true;
  const allowed = getCorsOriginValues(env);
  if (allowed.length === 0) return env.NODE_ENV !== 'production';
  try {
    const parsed = new URL(origin);
    const normalized = parsed.origin;
    return allowed.some((candidate) => {
      try {
        return new URL(candidate).origin === normalized;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
