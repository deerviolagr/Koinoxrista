import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';

const configuredBaseURL =
  process.env['BASE_URL'] ?? process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:4200';
const baseURL = configuredBaseURL.replace(/\/+$/, '');
const stateDir = `${workspaceRoot}/dist/.playwright/apps/web-e2e/states`;
const hasExternalBaseURL = Boolean(
  process.env['BASE_URL'] ?? process.env['E2E_BASE_URL'],
);
const localServer =
  process.env['E2E_USE_LOCAL_SERVER'] === '1' ||
  (!hasExternalBaseURL && process.env['E2E_USE_LOCAL_SERVER'] !== '0');

function localUrl(path: string): string {
  return new URL(path, `${baseURL}/`).toString();
}

export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './src' }),
  globalSetup: localServer ? './src/support/global-setup.ts' : undefined,
  fullyParallel: false,
  workers: process.env['CI'] ? 1 : undefined,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI']
    ? [['line'], ['html', { outputFolder: 'dist/.playwright/apps/web-e2e/playwright-report', open: 'never' }]]
    : [['list']],
  use: {
    baseURL,
    locale: 'el-GR',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: localServer
    ? {
        // The web dev server proxies /api to the API's explicit port 3000.
        command:
          'pnpm exec nx run-many --targets=serve --projects=api,web --parallel=2',
        url: localUrl('/login'),
        reuseExistingServer: !process.env['CI'],
        cwd: workspaceRoot,
        timeout: 180_000,
        env: {
          NODE_ENV: 'development',
          PORT: '3000',
          E2E_HOST: '127.0.0.1',
          E2E_PORT: '3000',
          // E2E deliberately exercises login, retries and multiple browser
          // projects; a production-sized login budget must not make runs flaky.
          RATE_LOGIN_LIMIT: '100',
          RATE_LOGIN_TTL_MS: '60000',
          THROTTLE_LIMIT: '1000',
          THROTTLE_TTL_MS: '60000',
        },
      }
    : undefined,
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium-admin',
      testMatch: /admin-modules\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: `${stateDir}/admin.json`,
      },
      dependencies: ['setup'],
    },
    {
      name: 'chromium-resident',
      testMatch: /resident\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: `${stateDir}/resident.json`,
      },
      dependencies: ['setup'],
    },
    {
      name: 'chromium-login',
      testMatch: /login\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
});
