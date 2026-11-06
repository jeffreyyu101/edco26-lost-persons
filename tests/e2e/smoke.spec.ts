import { execFile } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { ROOT } from '../../scripts/test-env.mjs';
import { signedInAs } from './helpers/session';

// Phase 1a smoke: the sign-in route renders under the production CSP and hydrates; `/` without a session
// redirects to sign-in with `next`; with a session, in-app navigation (push, replace, back) changes the
// view; and scripts/smoke-csp.mjs (the §9.6 CSP check, both engines) passes, so it can't go stale. Feature
// specs live in their own files (signin, list, new-request, …).
test('sign-in renders with a nonce CSP and hydrates', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  const response = await page.goto('/signin');
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(response?.headers()['x-frame-options']).toBe('DENY');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  await expect(page.getByRole('heading', { name: 'Staff sign-in' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('/ without a session goes to sign-in and keeps the view', async ({ page }) => {
  await page.goto('/?view=mine');
  await expect(page).toHaveURL(/\/signin\?next=%2F%3Fview%3Dmine$/);
});

// Signed-in shell over the real store and the seeded local database (LP-1012 is "Kayla Martinez").
test.describe('signed-in navigation', () => {
  const KAYLA = '5eed0000-0000-4000-8000-000000001012';
  let errors: string[];

  // Signed in once through POST /api/session (A17).
  signedInAs({ staffName: 'TEST-e2e Smoke', team: 'Medical' });

  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  // Regression: replaceState used to copy Next's `__NA` state, so the URL changed but the view did not.
  test('closing a deep-linked profile (replace fallback) shows the list', async ({ page }) => {
    await page.goto(`/?r=${KAYLA}`);
    await expect(page.getByTestId('profile')).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
    await expect(page.getByTestId('request-list')).toBeVisible();
    await expect(page.getByTestId('profile')).toHaveCount(0);
  });

  test('typing in search updates the results (replace) and Cancel returns to the list', async ({ page }) => {
    await page.goto('/?q=');
    // No count before anything is typed.
    await expect(page.getByRole('searchbox', { name: 'Search requests' })).toBeVisible();
    await expect(page.getByText(/^\d+ results?$/)).toHaveCount(0);
    await page.getByRole('searchbox', { name: 'Search requests' }).fill('Martinez');
    await expect(page).toHaveURL(/\?q=Martinez$/);
    // The shared local database also holds other runs' synthetic Martinez rows (A17: nothing is truncated),
    // so the count is checked for its shape, and the seeded row for its presence.
    await expect(page.getByText(/^\d+ results?$/)).toBeVisible();
    await expect(page.locator(`[data-request-id="${KAYLA}"]`)).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
    await expect(page.getByTestId('request-list')).toBeVisible();
  });

  test('push to a profile, then Close goes back to the same list view', async ({ page }) => {
    await page.goto('/?view=pending');
    await expect(page.getByTestId('request-list')).toBeVisible();
    await page.locator(`[data-request-id="${KAYLA}"]`).click();
    await expect(page).toHaveURL(new RegExp(`\\?r=${KAYLA}$`));
    await expect(page.getByTestId('profile')).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page).toHaveURL(/\?view=pending$/);
    await expect(page.getByTestId('request-list')).toBeVisible();
    await expect(page.getByTestId('profile')).toHaveCount(0);
  });
});

// scripts/smoke-csp.mjs drives Chromium and WebKit itself against this server, so one project runs it.
test('scripts/smoke-csp.mjs passes against this production build', async ({ baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-iphone14', 'the script runs both engines itself');
  test.setTimeout(180_000);
  const port = new URL(baseURL as string).port;
  const run = await new Promise<{ code: number; output: string }>((resolve) => {
    execFile(process.execPath, ['scripts/smoke-csp.mjs'], { cwd: ROOT, env: { ...process.env, PORT: port }, timeout: 170_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
  const output = run.output;
  expect(run.code, output).toBe(0);
  expect(output).toMatch(/^chromium: ok/m);
  expect(output).toMatch(/^webkit: ok/m);
});
