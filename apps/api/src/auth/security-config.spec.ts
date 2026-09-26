import {
  corsOrigins,
  getTwoFactorSecret,
  isAllowedAuthOrigin,
  validateProductionConfig,
} from './security-config';

const strong = (label: string): string =>
  `${label}-A9b8C7d6E5f4G3h2J1k0L9m8N7p6Q5r4S3t2U1v0`;

describe('production security configuration', () => {
  const validEnv = (): NodeJS.ProcessEnv => ({
    NODE_ENV: 'production',
    JWT_ACCESS_SECRET: strong('access'),
    JWT_REFRESH_SECRET: strong('refresh'),
    JWT_2FA_SECRET: strong('two-factor'),
    CORS_ORIGINS: 'https://app.example.gr,https://admin.example.gr',
  });

  it('accepts strong, distinct secrets and an explicit origin allow-list', () => {
    expect(() => validateProductionConfig(validEnv())).not.toThrow();
    expect(corsOrigins(validEnv())).toEqual([
      'https://app.example.gr',
      'https://admin.example.gr',
    ]);
    expect(getTwoFactorSecret(validEnv())).toBe(validEnv().JWT_2FA_SECRET);
  });

  it.each([
    ['missing access secret', { JWT_ACCESS_SECRET: '' }],
    ['weak access secret', { JWT_ACCESS_SECRET: 'a'.repeat(32) }],
    ['missing dedicated 2FA secret', { JWT_2FA_SECRET: '' }],
    [
      'same access and refresh secret',
      { JWT_REFRESH_SECRET: strong('access') },
    ],
  ])('rejects %s', (_label, override) => {
    expect(() =>
      validateProductionConfig({ ...validEnv(), ...override }),
    ).toThrow();
  });

  it('rejects wildcard and malformed production origins', () => {
    expect(() =>
      validateProductionConfig({ ...validEnv(), CORS_ORIGINS: '*' }),
    ).toThrow(/wildcard/i);
    expect(() =>
      validateProductionConfig({
        ...validEnv(),
        CORS_ORIGINS: 'not-an-origin',
      }),
    ).toThrow(/invalid origin/i);
    expect(() =>
      validateProductionConfig({ ...validEnv(), CORS_ORIGINS: '' }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it('does not constrain development defaults, but checks explicit origins', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
    expect(() => validateProductionConfig(env)).not.toThrow();
    expect(corsOrigins(env)).toBe(true);
    expect(isAllowedAuthOrigin('https://evil.example', env)).toBe(true);
    expect(
      isAllowedAuthOrigin('https://evil.example', {
        ...env,
        CORS_ORIGINS: 'https://good.example',
      }),
    ).toBe(false);
  });
});
