import { expect, test } from '@playwright/test';

// Phase 1a smoke: the sign-in route renders under the production CSP and hydrates; `/` without a session
// redirects to sign-in with `next`. Feature specs live in their own files (signin, list, new-request, …).
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
