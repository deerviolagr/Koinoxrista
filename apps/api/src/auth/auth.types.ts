import { Role } from '@prisma/client';

export type UserStatus =
  | 'ACTIVE'
  | 'PENDING_VERIFICATION'
  | 'PENDING_APPROVAL'
  | 'DISABLED'
  | 'REJECTED'
  | (string & {});

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  buildingId: string | null;
  /**
   * Live account state. Optional only for legacy in-memory callers; rows read
   * from Prisma always carry it and are checked by JwtStrategy.
   */
  status?: UserStatus;
}

export interface MeDto {
  id: string;
  email: string;
  role: Role;
  buildingId: string | null;
  status: UserStatus;
  market: string;
  currency: string;
  twoFactorEnabled: boolean;
  memberships: unknown[];
}

export interface AccessTokenPayload extends Omit<
  AuthenticatedUser,
  'id' | 'status'
> {
  sub: string;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  type: 'refresh';
}

export const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'change-me';
export const JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ?? 'change-me-too';
/** Canonical name; the ticket module also accepts the legacy aliases. */
export const JWT_2FA_SECRET =
  process.env.JWT_2FA_SECRET ??
  process.env.TWO_FACTOR_TICKET_SECRET ??
  process.env.JWT_TWO_FACTOR_SECRET ??
  process.env.TWO_FACTOR_JWT_SECRET ??
  process.env.JWT_2FA_TICKET_SECRET ??
  process.env.TWO_FACTOR_SECRET ??
  '';
export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL = '7d';
export const REFRESH_COOKIE_NAME = 'refresh_token';
export const REFRESH_COOKIE_PATH = '/api';
export const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Normalize an address at every identity boundary. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A DB row is active only when its explicit status is ACTIVE. */
export function isActiveStatus(status: unknown): boolean {
  return status === 'ACTIVE';
}

/** Minimal structural HTTP types (avoids a hard @types/express dependency). */
export interface HttpRequest {
  headers: {
    cookie?: string;
    authorization?: string;
    origin?: string;
    referer?: string;
    'user-agent'?: string;
  };
  ip?: string;
  user?: AuthenticatedUser;
  on(event: 'close', listener: () => void): this;
}

export interface HttpResponse {
  cookie(
    name: string,
    value: string,
    options?: {
      httpOnly?: boolean;
      sameSite?: 'lax' | 'strict' | 'none';
      maxAge?: number;
      expires?: Date;
      path?: string;
      secure?: boolean;
    },
  ): this;
  clearCookie?(
    name: string,
    options?: {
      httpOnly?: boolean;
      sameSite?: 'lax' | 'strict' | 'none';
      path?: string;
      secure?: boolean;
    },
  ): this;
  write(chunk: string): boolean;
  end(): void;
}
