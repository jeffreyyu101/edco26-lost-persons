import { randomUUID } from 'node:crypto';
import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { fakePush, type FakePushOptions } from './helpers/push';
import { newSignedInContext } from './helpers/session';

// F4 screenshots for design review (design/screens/f4-*.png), compared with the approved renders
// (alerts-banner-1..5, f34-v2-1..4, 7, 9). Off by default: LP_F4_SCREENS=1 npx playwright test f4-screens
// --project chromium-iphone14. Synthetic data only; every request is closed afterwards.

test.skip(process.env.LP_F4_SCREENS !== '1', 'Screenshots only on request (LP_F4_SCREENS=1).');
test.skip(({ browserName }) => browserName !== 'chromium', 'Screenshots are taken in Chromium.');

const BASE = testBaseUrl();
const SCREENS = { staffName: 'TEST-F4 Screens', team: 'GC/HX - Dispatch' };
const LIAISON = { staffName: 'TEST-F4 Screens Medic', team: 'Medical' };
const EMPTY = { staffName: `TEST-F4 Screens Empty ${Date.now().toString(36)}`, team: 'GC/HX - Base' };
const OUT = 'design/screens';
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

async function ctxFor(browser: Browser, kind: 'phone' | 'desk', theme: Theme, push: FakePushOptions): Promise<BrowserContext> {
  const base =
    kind === 'phone'
      ? { ...devices['iPhone 14'], viewport: { width: 390, height: 844 } }
      : { viewport: { width: 1440, height: 900 }, userAgent: devices['Desktop Chrome'].userAgent, isMobile: false, hasTouch: false, deviceScaleFactor: 1 };
  const ctx = await newSignedInContext(browser, SCREENS, { baseURL: BASE, ...base, colorScheme: theme });
  await ctx.addInitScript((t: Theme) => {
    localStorage.setItem('lp-theme', t);
  }, theme);
  await fakePush(ctx, push);
  return ctx;
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  // A list, an empty view or the desk table: the view's root is there.
  await expect(page.locator('[data-view], [data-testid="desk-table-view"]').first()).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
}

const shot = (page: Page, name: string, kind: 'phone' | 'desk', theme: Theme) =>
  page.screenshot({ path: `${OUT}/f4-${name}-${kind === 'phone' ? '390x844' : '1440x900'}-${theme}.png` });

async function seed(browser: Browser): Promise<{ created: RequestSummary[]; liaison: BrowserContext; me: BrowserContext }> {
  const me = await newSignedInContext(browser, SCREENS, { baseURL: BASE });
  const liaison = await newSignedInContext(browser, LIAISON, { baseURL: BASE });
  await me.request.post('/api/push/prefs', { headers: { origin: BASE }, data: { newRequests: true, myUpdates: true } });
  await me.request.post('/api/activity/read', { headers: { origin: BASE }, data: { all: true } });
  const created: RequestSummary[] = [];
  const log = async (who: BrowserContext, name: string) => {
    const res = await who.request.post('/api/requests', {
      headers: { origin: BASE },
      data: { clientMutationId: randomUUID(), reportingLocation: 'FA 4 – Oasis', name, age: '24', gender: 'Male', contactPhone: '407-555-0100' },
    });
    const r = ((await res.json()) as { request: RequestSummary }).request;
    created.push(r);
    return r;
  };
  const current = async (r: RequestSummary) => ((await (await liaison.request.get(`/api/sync?ids=${r.id}`)).json()) as { rows: RequestSummary[] }).rows[0] as RequestSummary;
  const status = async (r: RequestSummary, s: string, kind: string) => {
    const c = await current(r);
    await liaison.request.post(`/api/requests/${r.id}/status`, { headers: { origin: BASE }, data: { status: s, expectedVersion: c.rowVersion, kind } });
  };
  const patch = async (r: RequestSummary, p: Record<string, unknown>) => {
    const c = await current(r);
    await liaison.request.patch(`/api/requests/${r.id}`, { headers: { origin: BASE }, data: { patch: p, expectedVersion: c.rowVersion } });
  };
  const m = await log(me, 'Mae Price');
  await status(m, 'Found – Awaiting Reunion', 'answer');
  await status(m, 'Reunited – Closed', 'reunite');
  const t = await log(liaison, 'Tara Ruiz');
  const k = await log(me, 'Kim Tran');
  await status(k, 'Found – Awaiting Reunion', 'answer');
  await status(k, 'Added', 'undo');
  const rp = await log(me, 'Rory Park');
  await status(rp, 'Found – Awaiting Reunion', 'answer');
  await patch(rp, { medicalLocation: 'Chair 9' });
  await patch(rp, { medicalLocation: 'Bed 3' });
  const e = await log(me, 'Eli Moss');
  await patch(e, { clothing: 'Green raincoat' });
  const j = await log(me, 'Jo Diaz');
  await status(j, 'Found – Awaiting Reunion', 'answer');
  await patch(j, { medicalLocation: 'Chair 9' });
  // Read: the older ones (as if opened), unread: the newest three.
  for (const r of [m, t, k, rp]) await me.request.post('/api/activity/read', { headers: { origin: BASE }, data: { requestId: r.id } });
  return { created, liaison, me };
}

async function cleanup(s: { created: RequestSummary[]; liaison: BrowserContext; me: BrowserContext }) {
  for (const r of s.created) {
    const row = ((await (await s.liaison.request.get(`/api/sync?ids=${r.id}`)).json()) as { rows: RequestSummary[] }).rows[0];
    if (!row) continue;
    if (row.status === 'Added') await s.me.request.post(`/api/requests/${r.id}/cancel`, { headers: { origin: BASE }, data: { expectedVersion: row.rowVersion } });
    else if (row.status === 'Found – Awaiting Reunion')
      await s.liaison.request.post(`/api/requests/${r.id}/status`, { headers: { origin: BASE }, data: { status: 'Reunited – Closed', expectedVersion: row.rowVersion, kind: 'reunite' } });
  }
  await s.me.request.post('/api/push/prefs', { headers: { origin: BASE }, data: { newRequests: false, myUpdates: true } });
  await s.me.close();
  await s.liaison.close();
}

test('banners, the Alerts sheet, the bell and Activity, light and dark, phone and desk', async ({ browser }) => {
  test.setTimeout(600_000);
  const s = await seed(browser);
  try {
    for (const theme of THEMES) {
      // Banners.
      const banners: Array<[string, 'phone' | 'desk', FakePushOptions]> = [
        ['banner-off', 'phone', { permission: 'default', standalone: true }],
        ['banner-install', 'phone', { permission: 'default', noPush: true }],
        ['banner-blocked', 'phone', { permission: 'denied', standalone: true }],
        ['banner-off', 'desk', { permission: 'default' }],
        ['banner-blocked', 'desk', { permission: 'denied' }],
      ];
      for (const [name, kind, push] of banners) {
        const ctx = await ctxFor(browser, kind, theme, push);
        const page = await ctx.newPage();
        await open(page);
        await expect(page.getByTestId('alerts-banner').filter({ visible: true })).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(400);
        await shot(page, name, kind, theme);
        await ctx.close();
      }
      // Alerts on: the sheet; the bell; Activity unread, all read (Undo), empty; the desk popover.
      for (const kind of ['phone', 'desk'] as const) {
        const ctx = await ctxFor(browser, kind, theme, { permission: 'granted', subscribed: true });
        const page = await ctx.newPage();
        await open(page);
        const bell = page.getByTestId('activity-bell').filter({ visible: true });
        await expect(bell).toHaveAccessibleName(/Activity, \d+ unread/, { timeout: 20_000 });
        await page.waitForTimeout(400);
        await shot(page, 'bell', kind, theme);
        if (kind === 'phone') {
          await page.getByTestId('account-trigger').click();
          await page.getByRole('dialog', { name: 'Account' }).getByTestId('alerts-menu').click();
        } else {
          await page.getByTestId('desk-alerts').click();
        }
        await expect(page.getByTestId('alerts-device')).toContainText('On for this', { timeout: 20_000 });
        await page.waitForTimeout(400);
        await shot(page, 'alerts-sheet', kind, theme);
        await page.keyboard.press('Escape');
        await bell.click();
        const panel = page.getByTestId(kind === 'phone' ? 'activity-sheet' : 'activity-popover');
        await expect(panel.getByTestId('activity-row').first()).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(500);
        await shot(page, 'activity-unread', kind, theme);
        await panel.getByRole('button', { name: 'Mark all read' }).click();
        await expect(panel.getByTestId('activity-undo')).toBeVisible();
        await shot(page, 'activity-all-read', kind, theme);
        await panel.getByTestId('activity-undo').getByRole('button', { name: 'Undo' }).click();
        await expect(bell).toHaveAccessibleName(/Activity, \d+ unread/);
        await ctx.close();
      }
      for (const kind of ['phone', 'desk'] as const) {
        const fresh = await newSignedInContext(
          browser,
          EMPTY,
          kind === 'phone'
            ? { baseURL: BASE, ...devices['iPhone 14'], viewport: { width: 390, height: 844 }, colorScheme: theme }
            : { baseURL: BASE, viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, colorScheme: theme },
        );
        await fresh.addInitScript((t: Theme) => localStorage.setItem('lp-theme', t), theme);
        await fakePush(fresh, { permission: 'granted', subscribed: true });
        const page = await fresh.newPage();
        await open(page);
        await page.getByTestId('activity-bell').filter({ visible: true }).click();
        await expect(page.getByTestId('activity-empty')).toBeVisible();
        await page.waitForTimeout(400);
        await shot(page, 'activity-empty', kind, theme);
        await fresh.close();
      }
    }
  } finally {
    await cleanup(s);
  }
});
