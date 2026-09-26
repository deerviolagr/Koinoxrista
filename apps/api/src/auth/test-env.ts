// Deterministic JWT secrets for unit tests (imported by every auth spec
// before any token signing/verification happens).
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-012345678901234567890123';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ?? 'test-refresh-secret-012345678901234567890123';
process.env.JWT_2FA_SECRET =
  process.env.JWT_2FA_SECRET ?? 'test-2fa-secret-012345678901234567890123456';

export {};
