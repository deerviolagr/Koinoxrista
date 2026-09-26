import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'el'));
});

/**
 * Runs with the resident storageState from the setup project, so each test
 * restores the session via /auth/refresh (no login round-trips).
 */
test.describe('resident flow', () => {
  test('balance page renders for the resident', async ({ page }) => {
    await page.goto('/balance');
    await expect(
      page.getByRole('heading', { name: 'Υπόλοιπό μου' }),
    ).toBeVisible();
  });

  test('statement page renders', async ({ page }) => {
    await page.goto('/balance/statement');
    await expect(page).toHaveURL(/\/balance\/statement$/);
  });
});
