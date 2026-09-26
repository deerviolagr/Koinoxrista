import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const TWO_FACTOR_TICKET_TTL_MS = 5 * 60 * 1000;
export const TWO_FACTOR_TICKET_MAX_ATTEMPTS = 5;
export const TWO_FACTOR_TICKET_ATTEMPT_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_TWO_FACTOR_TICKET_SECRET =
  'dev-only-two-factor-ticket-secret';

interface TicketPayload {
  sub: string;
  /** Epoch ms after which the ticket is invalid. */
  exp: number;
  /** Unique nonce prevents two password challenges from sharing identity. */
  jti?: string;
}

interface AttemptState {
  failures: number[];
  lockedUntil: number | null;
}

/** A small process-local guard; the ticket row remains the durable one-use gate. */
const consumedTickets = new Map<string, number>();
const attempts = new Map<string, AttemptState>();
const MAX_TICKET_STATE_KEYS = 10_000;

/** Error used by AuthService to turn brute-force attempts into a 429. */
export class LoginTicketRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('Too many invalid two-factor attempts');
    this.name = 'LoginTicketRateLimitError';
  }
}

function configuredSecret(): string {
  const value =
    process.env.JWT_2FA_SECRET?.trim() ||
    process.env.TWO_FACTOR_TICKET_SECRET?.trim() ||
    process.env.JWT_TWO_FACTOR_SECRET?.trim() ||
    process.env.TWO_FACTOR_JWT_SECRET?.trim() ||
    process.env.JWT_2FA_TICKET_SECRET?.trim() ||
    process.env.TWO_FACTOR_SECRET?.trim() ||
    '';
  if (
    !value ||
    value === DEFAULT_TWO_FACTOR_TICKET_SECRET ||
    value === 'change-me' ||
    value === 'change-me-too'
  ) {
    throw new Error(
      'A dedicated, non-default JWT_2FA_SECRET is required for two-factor tickets',
    );
  }
  return value;
}

function hmac(payload: string, secret = configuredSecret()): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Stable storage key; the raw signed ticket is never persisted. */
export function hashLoginTicket(ticket: string): string {
  return createHash('sha256')
    .update(`two-factor-login-ticket:${ticket}`, 'utf8')
    .digest('hex');
}

function attemptKey(ticket: string): string {
  return hashLoginTicket(ticket);
}

function prune(map: Map<string, number>, now: number): void {
  for (const [key, expiresAt] of map) {
    if (expiresAt <= now) map.delete(key);
  }
}

function trimAttemptState(): void {
  while (attempts.size > MAX_TICKET_STATE_KEYS) {
    const oldest = attempts.keys().next().value as string | undefined;
    if (!oldest) return;
    attempts.delete(oldest);
  }
}

function assertAttemptsOpen(ticket: string, now: number): void {
  const state = attempts.get(attemptKey(ticket));
  if (!state) return;
  if (state.lockedUntil !== null && state.lockedUntil > now) {
    throw new LoginTicketRateLimitError(state.lockedUntil - now);
  }
  if (state.lockedUntil !== null) {
    state.lockedUntil = null;
    state.failures = [];
  }
}

/** Throws when this challenge has exhausted its invalid-code allowance. */
export function assertLoginTicketAttemptsOpen(
  ticket: string,
  now = Date.now(),
): void {
  assertAttemptsOpen(ticket, now);
}

/** Record one invalid code and return true when the challenge is now locked. */
export function recordLoginTicketFailure(
  ticket: string,
  now = Date.now(),
): boolean {
  const key = attemptKey(ticket);
  assertAttemptsOpen(ticket, now);
  const state = attempts.get(key) ?? { failures: [], lockedUntil: null };
  const cutoff = now - TWO_FACTOR_TICKET_ATTEMPT_TTL_MS;
  state.failures = state.failures.filter((timestamp) => timestamp > cutoff);
  state.failures.push(now);
  if (state.failures.length >= TWO_FACTOR_TICKET_MAX_ATTEMPTS) {
    state.lockedUntil = now + TWO_FACTOR_TICKET_ATTEMPT_TTL_MS;
    state.failures = [];
    attempts.set(key, state);
    trimAttemptState();
    return true;
  }
  attempts.set(key, state);
  trimAttemptState();
  return false;
}

export function resetLoginTicketAttempts(ticket: string): void {
  attempts.delete(attemptKey(ticket));
}

/** Mark a ticket consumed in the process-local fallback store. */
export function consumeLoginTicketLocally(
  ticket: string,
  now = Date.now(),
): boolean {
  prune(consumedTickets, now);
  const key = attemptKey(ticket);
  if (consumedTickets.has(key)) return false;
  consumedTickets.set(key, now + TWO_FACTOR_TICKET_TTL_MS);
  while (consumedTickets.size > MAX_TICKET_STATE_KEYS) {
    const oldest = consumedTickets.keys().next().value as string | undefined;
    if (!oldest) break;
    consumedTickets.delete(oldest);
  }
  return true;
}

/** Test-only hook; does not affect production code paths. */
export function resetLoginTicketState(): void {
  consumedTickets.clear();
  attempts.clear();
}

/** Signs a short-lived login ticket for the given user. */
export function signLoginTicket(userId: string, nowMs = Date.now()): string {
  if (!userId) throw new Error('userId is required for a login ticket');
  // Resolve before constructing the payload so a missing/default key can never
  // result in a usable ticket.
  const secret = configuredSecret();
  const payload: TicketPayload = {
    sub: userId,
    exp: nowMs + TWO_FACTOR_TICKET_TTL_MS,
    jti: randomBytes(16).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  return `${encoded}.${hmac(encoded, secret)}`;
}

/**
 * Validates signature + expiry; returns the userId or null when the ticket is
 * malformed, tampered with, expired, or signed with an unavailable/default key.
 */
export function verifyLoginTicket(
  ticket: string,
  nowMs = Date.now(),
): string | null {
  if (
    typeof ticket !== 'string' ||
    ticket.length < 16 ||
    ticket.length > 1024
  ) {
    return null;
  }
  const separator = ticket.indexOf('.');
  if (separator <= 0 || separator !== ticket.lastIndexOf('.')) return null;
  const encoded = ticket.slice(0, separator);
  const signature = ticket.slice(separator + 1);
  if (!encoded || !signature) return null;

  let expected: string;
  try {
    expected = hmac(encoded);
  } catch {
    return null;
  }
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(signature, 'utf8');
  if (
    expectedBytes.length !== providedBytes.length ||
    !timingSafeEqual(expectedBytes, providedBytes)
  ) {
    return null;
  }

  let payload: TicketPayload;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as TicketPayload;
  } catch {
    return null;
  }
  if (
    typeof payload?.sub !== 'string' ||
    payload.sub.length === 0 ||
    typeof payload?.exp !== 'number' ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= nowMs ||
    (payload.jti !== undefined &&
      (typeof payload.jti !== 'string' || payload.jti.length === 0))
  ) {
    return null;
  }
  return payload.sub;
}
