import { expect, test } from '@playwright/test';
import { addSessionCookie } from './helpers/session';

// Phase 1a smoke: the sign-in route renders under the production CSP and hydrates; `/` without a session
// redirects to sign-in with `next`; with a session, in-app navigation (push, replace, back) changes the
// view. Feature specs live in their own files (signin, list, new-request, …).
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

// Signed-in shell over the Phase 1a stub store (synthetic rows; LP-1012 is "Kayla Martinez").
test.describe('signed-in navigation', () => {
  const KAYLA = '5eed0000-0000-4000-8000-000000001012';
  let errors: string[];

  test.beforeEach(async ({ context, page }) => {
    await addSessionCookie(context);
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
    await expect(page.getByText('0 results', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Search requests' }).fill('Kayla');
    await expect(page).toHaveURL(/\?q=Kayla$/);
    await expect(page.getByText('1 result', { exact: true })).toBeVisible();
    await expect(page.locator(`[data-request-id="${KAYLA}"]`)).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
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
