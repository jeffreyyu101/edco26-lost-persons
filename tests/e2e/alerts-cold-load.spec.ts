import { expect, test, type Page } from '@playwright/test';
import { signedInAs } from './helpers/session';

// (Phase 3) The alerts reminder on a cold load. It can only be drawn once /api/push/prefs answers, often after the
// list's first paint; it used to push everything under it down (128 px on a phone, 90 px on the desk) on every cold
// load. The device now remembers the banner it showed (components/alerts/banner-place.tsx) and holds its place from
// the first paint: the first-ever visit still shifts, a second cold load does not. An iPhone Safari tab here, so the
// banner is the "install" one. Runs in both browsers.

signedInAs({ staffName: 'TEST-P3 Cold Load', team: 'GC/HX - Dispatch' });
// page.route() never sees a request a service worker passes on in WebKit; a cold load is the network's anyway.
test.use({ serviceWorkers: 'block' });

/** Records the first request row's top the moment it first appears (window.__firstRow), on every load. */
async function watchFirstRow(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __firstRow?: { id: string; y: number } };
    const observer = new MutationObserver(() => {
      const row = document.querySelector<HTMLElement>('[data-request-id]');
      if (w.__firstRow || !row) return;
      w.__firstRow = { id: row.getAttribute('data-request-id') ?? '', y: row.getBoundingClientRect().top };
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
}

/** How far the row first seen on this load has moved since, once the banner is in. */
async function shiftSinceFirstPaint(page: Page): Promise<number> {
  await expect(page.getByTestId('alerts-banner').filter({ visible: true })).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __firstRow?: unknown }).__firstRow)).toBe(true);
  return page.evaluate(() => {
    const first = (window as unknown as { __firstRow: { id: string; y: number } }).__firstRow;
    const row = document.querySelector<HTMLElement>(`[data-request-id="${CSS.escape(first.id)}"]`);
    return Math.round((row?.getBoundingClientRect().top ?? Number.NaN) - first.y);
  });
}

async function coldLoads(page: Page) {
  // The answer lands well after the rows' first paint: the race the banner used to lose, made certain.
  await page.route('**/api/push/prefs', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await route.continue();
  });
  await watchFirstRow(page);
  await page.goto('/');
  const first = await shiftSinceFirstPaint(page);
  // The device now remembers the banner's state and box.
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lp-alerts-banner') ?? 'null')?.s ?? null)).toBe('install');
  await page.reload();
  // The remembered box is there before the answer, then the banner takes its place.
  await expect(page.getByTestId('alerts-banner-place')).toHaveCount(1);
  const second = await shiftSinceFirstPaint(page);
  await expect(page.getByTestId('alerts-banner-place')).toHaveCount(0);
  return { first, second };
}

test('phone: the first-ever visit shifts the list once; a second cold load does not move it', async ({ page }) => {
  const { first, second } = await coldLoads(page);
  expect(first).toBeGreaterThan(60);
  expect(second).toBe(0);
});

test.describe('desk', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test('desk table: the first-ever visit shifts the table once; a second cold load does not move it', async ({ page }) => {
    const { first, second } = await coldLoads(page);
    expect(first).toBeGreaterThan(40);
    expect(second).toBe(0);
  });
});

test('no banner any more (the answer says so): the remembered box goes and is forgotten', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('lp-alerts-banner', JSON.stringify({ s: 'install', at: { list: { h: 128, m: '12px 12px 0px' } } }));
        sessionStorage.setItem('seeded', '1');
      }
    } catch {
      // Private mode.
    }
  });
  await page.route('**/api/push/prefs', (route) => route.fulfill({ json: { enabled: false, publicKey: null, newRequests: false, myUpdates: true } }));
  await page.goto('/');
  await expect(page.locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('alerts-banner-place')).toHaveCount(0);
  await expect(page.getByTestId('alerts-banner')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lp-alerts-banner'))).toBeNull();
});
