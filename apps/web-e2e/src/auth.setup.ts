import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

const ADMIN = { email: 'admin@demo.gr', password: 'Admin1234!' };
const RESIDENT = { email: 'maria@demo.gr', password: 'Password123!' };
const stateDir = join(__dirname, '../../../dist/.playwright/apps/web-e2e/states');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await mkdir(stateDir, { recursive: true });
  // Only remove this test project's state files. Never clean a user's browser
  // profile or an arbitrary workspace directory.
  await Promise.all([
    rm(join(stateDir, 'admin.json'), { force: true }),
    rm(join(stateDir, 'resident.json'), { force: true }),
  ]);
});

async function prepareGreekSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('locale', 'el');
  });
}

test('authenticate as admin', async ({ page }) => {
  await prepareGreekSession(page);
  await page.goto('/login');
  await page.fill('#email', ADMIN.email);
  await page.fill('#password', ADMIN.password);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/admin(?:[/?#]|$)/);
  await page.context().storageState({ path: join(stateDir, 'admin.json') });
});

test('authenticate as resident', async ({ page }) => {
  await prepareGreekSession(page);
  await page.goto('/login');
  await page.fill('#email', RESIDENT.email);
  await page.fill('#password', RESIDENT.password);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/balance(?:[/?#]|$)/);
  await page.context().storageState({ path: join(stateDir, 'resident.json') });
});
