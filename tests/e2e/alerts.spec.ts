import { randomUUID } from 'node:crypto';
import { devices, expect, test, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type Worker } from '@playwright/test';
import type { RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { fakePush, fakePushState, workerReady, type FakePushOptions } from './helpers/push';
import { OVERFLOW_WIDTHS, expectNoOverflow } from './helpers/overflow';
import { newSignedInContext, signedInAs } from './helpers/session';

// The alerts reminder banner and the Alerts sheet (F4, design/screens/alerts-banner.html, f34-v2-7): on All,
// Pending and My requests until lock-screen alerts work on this device, then gone; the exact taps for this
// device; Turn on asks from the tap and subscribes; a later revoke brings it back; the switches are
// server-side; and no double alert (a subscribed device's page never shows its own system notification).
// Web Push itself is faked in the page (helpers/push.ts); the real service worker of this build answers.

const BASE = testBaseUrl();
const PHONE = { staffName: 'TEST-F4 Alerts Phone', team: 'GC/HX - Dispatch' };
const DESK = { staffName: 'TEST-F4 Alerts Desk', team: 'Medical' };
const FRONT = { staffName: 'TEST-F4 Alerts Front', team: 'GC/HX - Dispatch' };
const TAG = `TEST-F4A-${Date.now().toString(36)}`;

signedInAs(PHONE);

async function openApp(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  // A list, an empty view or the desk table: the view's root is there.
  await expect(page.locator('[data-view], [data-testid="desk-table-view"]').first()).toBeVisible({ timeout: 15_000 });
}

const banner = (page: Page) => page.getByTestId('alerts-banner').filter({ visible: true });

/**
 * Runs this build's worker push handler on `payload` (a PushEvent dispatched in the worker: headless Chromium
 * has no push service) and answers the notifications it showed ({title, tag, silent}), recorded from
 * registration.showNotification itself (the headless shell keeps none to list).
 */
async function dispatchPush(worker: Worker, payload: Record<string, unknown>): Promise<Array<{ title: string; tag: string; silent: boolean }>> {
  return worker.evaluate(async (data) => {
    const sw = self as unknown as {
      dispatchEvent(e: Event): boolean;
      registration: { showNotification(title: string, options?: { tag?: string; silent?: boolean }): Promise<void> };
    };
    const shown: Array<{ title: string; tag: string; silent: boolean }> = [];
    const real = sw.registration.showNotification;
    sw.registration.showNotification = function (title, options) {
      shown.push({ title, tag: options?.tag ?? '', silent: options?.silent === true });
      return real.call(this, title, options).catch(() => undefined);
    };
    try {
      const PushEventCtor = (self as unknown as { PushEvent: new (type: string, init: { data: string }) => Event }).PushEvent;
      const waits: Promise<unknown>[] = [];
      const event = new PushEventCtor('push', { data: JSON.stringify(data) });
      const extend = (event as unknown as { waitUntil(p: Promise<unknown>): void }).waitUntil.bind(event);
      (event as unknown as { waitUntil(p: Promise<unknown>): void }).waitUntil = (p: Promise<unknown>) => {
        waits.push(p);
        try {
          extend(p);
        } catch {
          // a synthetic event may not be extendable
        }
      };
      sw.dispatchEvent(event);
      await Promise.all(waits);
    } finally {
      sw.registration.showNotification = real;
    }
    return shown;
  }, payload);
}

async function context(browser: Browser, staff: typeof PHONE, kind: 'iphone' | 'desktop' | 'ipad', push: FakePushOptions, extra: BrowserContextOptions = {}): Promise<BrowserContext> {
  const d = kind === 'iphone' ? devices['iPhone 14'] : kind === 'ipad' ? devices['iPad Pro 11'] : devices['Desktop Chrome'];
  const ctx = await newSignedInContext(browser, staff, {
    baseURL: BASE,
    viewport: kind === 'desktop' ? { width: 1440, height: 900 } : d.viewport,
    userAgent: d.userAgent,
    deviceScaleFactor: d.deviceScaleFactor,
    isMobile: kind !== 'desktop' && browser.browserType().name() !== 'firefox',
    hasTouch: kind !== 'desktop',
    ...extra,
  });
  await fakePush(ctx, push);
  return ctx;
}

test.describe('the banner, by device', () => {
  test('an iPhone Safari tab: "Get alerts on your lock screen" with the taps, on All, Pending and My requests only', async ({ page, context: ctx }) => {
    await fakePush(ctx, { permission: 'default', noPush: true });
    await openApp(page);
    const b = banner(page);
    await expect(b).toBeVisible({ timeout: 15_000 });
    await expect(b).toContainText('Get alerts on your lock screen');
    const chips = b.getByTestId('step-chip');
    // Playwright's iPhone 14 is Safari 27 (Version/27.2): Page Menu → Share → Add to Home Screen → Add. Open as
    // Web App is already on there (iOS 26+): never a chip, or people switch it off and get a bookmark.
    await expect(chips).toHaveText(['Menu', 'Share', 'Add to Home Screen', 'Add']);
    // Not dismissible; screen readers hear the path as one sentence.
    await expect(b.getByRole('button')).toHaveCount(0);
    await expect(b).toContainText('Add this app to your Home Screen: tap Menu, then Share, then Add to Home Screen, then keep Open as Web App on, then Add.');
    await openApp(page, '/?view=pending');
    await expect(banner(page)).toBeVisible();
    await openApp(page, '/?view=mine');
    await expect(banner(page)).toBeVisible();
    await page.goto('/?q=x');
    await expect(page.getByRole('searchbox').first()).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    expect((await fakePushState(page)).subscribeCalls).toBe(0);
  });

  test('the iPhone Home Screen app: Alerts are off → Turn on subscribes from the tap; the banner goes and the Alerts sheet opens once', async ({ browser, browserName }) => {
    const ctx = await context(browser, PHONE, 'iphone', { permission: 'default', standalone: true });
    try {
      const page = await ctx.newPage();
      await openApp(page);
      await workerReady(page);
      const b = banner(page);
      await expect(b).toContainText('Alerts are off', { timeout: 20_000 });
      const posted = page.waitForRequest((r) => r.url().endsWith('/api/push/subscribe') && r.method() === 'POST');
      await b.getByRole('button', { name: 'Turn on' }).click();
      const body = (await posted).postDataJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      expect(body.endpoint).toMatch(/^https:\/\/127\.0\.0\.1:9\/e2e\//);
      expect((await fakePushState(page)).subscribeCalls).toBe(1);
      await expect(b).toHaveCount(0);
      const sheet = page.getByRole('dialog', { name: 'Alerts' });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByTestId('alerts-device')).toContainText('On for this phone');
      // Send a test alert: a real push to this device only (the push service is faked here).
      await page.route('**/api/push/test', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sent: true }) }));
      const test = page.waitForRequest((r) => r.url().endsWith('/api/push/test'));
      await sheet.getByTestId('alerts-test').click();
      expect((await test).postDataJSON()).toEqual({ endpoint: body.endpoint });
      // (WebKit's page.route does not reach requests of a page its service worker controls: there the real
      // server answers, and the fake endpoint can't receive, so "Not sent · Try again" is the right answer.)
      await expect(sheet.getByTestId('alerts-test')).toContainText(browserName === 'chromium' ? 'Test alert sent' : /Test alert sent|Not sent · Try again/);
      await page.keyboard.press('Escape');
      // A reload: still on, the sheet does not open again, nothing asks again.
      await page.reload();
      await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(1_500);
      await expect(banner(page)).toHaveCount(0);
      await expect(page.getByRole('dialog', { name: 'Alerts' })).toHaveCount(0);
      expect((await fakePushState(page)).subscribeCalls).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test('the iPhone Home Screen app, blocked: the Settings path; no re-check button on a phone', async ({ browser }) => {
    const ctx = await context(browser, PHONE, 'iphone', { permission: 'denied', standalone: true });
    try {
      const page = await ctx.newPage();
      await openApp(page);
      const b = banner(page);
      await expect(b).toContainText('Alerts are blocked', { timeout: 20_000 });
      // Settings lists the Home Screen app under its Home Screen name (the manifest's short_name).
      await expect(b.getByTestId('step-chip')).toHaveText(['Settings', 'Notifications', 'In medical?', 'Allow Notifications']);
      await expect(b.getByTestId('alerts-recheck')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('desktop Chrome: Turn on, then a revoke in the site settings brings it back blocked; allowed again, re-check turns it on', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'Desktop Chrome is checked in Chromium.');
    const ctx = await context(browser, DESK, 'desktop', { permission: 'default' });
    try {
      const page = await ctx.newPage();
      await openApp(page);
      await workerReady(page);
      const b = banner(page);
      await expect(b).toContainText('Alerts are off', { timeout: 20_000 });
      await b.getByRole('button', { name: 'Turn on' }).click();
      await expect(b).toHaveCount(0);
      await page.keyboard.press('Escape');
      // Revoked in the browser's site settings.
      await page.evaluate(() => {
        window.__fakePush.perm = 'denied';
        window.dispatchEvent(new Event('focus'));
      });
      await expect(b).toContainText('Alerts are blocked');
      await expect(b.getByTestId('step-chip')).toHaveText(['Icon left of the address', 'Notifications', 'On']);
      // Allowed again: the re-check subscribes without asking.
      await page.evaluate(() => {
        window.__fakePush.perm = 'granted';
      });
      await b.getByTestId('alerts-recheck').click();
      await expect(b).toHaveCount(0);
      // The menu says it.
      await page.getByTestId('desk-sidebar').getByTestId('desk-alerts').click();
      await expect(page.getByRole('dialog', { name: 'Alerts' }).getByTestId('alerts-device')).toContainText('On for this computer');
    } finally {
      await ctx.close();
    }
  });

  test('no Web Push in the browser: no banner', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'Desktop Chrome is checked in Chromium.');
    const ctx = await context(browser, DESK, 'desktop', { permission: 'default', noPush: true });
    try {
      const page = await ctx.newPage();
      await openApp(page);
      await workerReady(page);
      await page.waitForTimeout(2_000);
      await expect(banner(page)).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
});

test.describe('no double alerts (F4 + system notifications)', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Checked in Chromium (CDP delivers the push).');

  test('a push while the app is in front shows no notification and makes the page sync; a subscribed page in the background shows none of its own', async ({ browser }) => {
    test.slow();
    const ctx = await context(browser, DESK, 'desktop', { permission: 'granted', subscribed: true });
    await ctx.grantPermissions(['notifications'], { origin: BASE });
    const prefs = await ctx.request.post('/api/push/prefs', { headers: { origin: BASE }, data: { newRequests: true } });
    expect(prefs.status()).toBe(200);
    // The page's own system notifications (v2.5 A52), spied on.
    await ctx.addInitScript(() => {
      const w = window as unknown as { __pageShown: string[] };
      w.__pageShown = [];
      const real = ServiceWorkerRegistration.prototype.showNotification;
      ServiceWorkerRegistration.prototype.showNotification = function (title: string, options?: NotificationOptions) {
        w.__pageShown.push(title);
        return real.call(this, title, options);
      };
    });
    const front = await newSignedInContext(browser, FRONT, { baseURL: BASE });
    const created: string[] = [];
    try {
      const page = await ctx.newPage();
      await openApp(page);
      await workerReady(page);
      // Subscribed and told the server: no banner.
      await expect(page.getByTestId('desk-sidebar').getByTestId('desk-alerts')).toHaveAccessibleName('Alerts On', { timeout: 20_000 });
      await page.bringToFront();

      // A push arrives while the window is visible and focused: this build's worker runs its push handler (a
      // PushEvent dispatched in the worker: headless Chromium has no push service), shows nothing, and the page
      // syncs at once. No badge in this payload: navigator.setAppBadge in a worker crashes the headless shell
      // (the badge itself is unit-tested).
      const worker = ctx.serviceWorkers().find((w) => w.url().startsWith(`${BASE}/sw.js`)) ?? (await ctx.waitForEvent('serviceworker'));
      const id = randomUUID();
      const synced = page.waitForRequest((r) => r.url().includes('/api/sync'), { timeout: 10_000 });
      const shown = await dispatchPush(worker, { v: 1, title: 'J.D.', body: 'In medical', tag: `lp-${id}`, url: `/?r=${id}`, kind: 'in_medical', requestId: id, renotify: false, badge: null });
      expect(shown).toEqual([]);
      await synced;

      // "Send a test alert" is tapped inside the app, so the app is always in front then: it still shows.
      const testShown = await dispatchPush(worker, { v: 1, title: 'Is my friend in medical?', body: 'Test alert', tag: 'lp-test', url: '/', kind: 'test', requestId: null, renotify: true, badge: null });
      expect(testShown).toEqual([{ title: 'Is my friend in medical?', tag: 'lp-test', silent: false }]);

      // In the background, a new request by someone else: the push carries it, so the page shows nothing.
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.hasFocus = () => false;
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('blur'));
      });
      const res = await front.request.post('/api/requests', {
        headers: { origin: BASE },
        data: { clientMutationId: randomUUID(), reportingLocation: 'FA 3 – Kinetic', name: `${TAG} Push`, age: '30', contactPhone: '407-555-0100' },
      });
      expect(res.status()).toBe(201);
      const r = ((await res.json()) as { request: RequestSummary }).request;
      created.push(r.id);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await expect(page.locator(`[data-request-id="${r.id}"]`).first()).toBeAttached({ timeout: 15_000 });
      await page.waitForTimeout(1_500);
      expect(await page.evaluate(() => (window as unknown as { __pageShown: string[] }).__pageShown)).toEqual([]);
      await expect(page.locator('.lp-toast').filter({ hasText: 'New request' })).toHaveCount(0);
    } finally {
      for (const id of created) {
        const detail = (await (await front.request.get(`/api/requests/${id}`)).json()) as RequestSummary;
        await front.request.post(`/api/requests/${id}/cancel`, { headers: { origin: BASE }, data: { expectedVersion: detail.rowVersion } });
      }
      await ctx.request.post('/api/push/prefs', { headers: { origin: BASE }, data: { newRequests: false } });
      await front.close();
      await ctx.close();
    }
  });
});

test.describe('the Alerts sheet', () => {
  test('the switches are server-side: New requests follows to a second device', async ({ browser }) => {
    const a = await context(browser, PHONE, 'iphone', { permission: 'default', noPush: true });
    const b = await context(browser, PHONE, 'iphone', { permission: 'default', noPush: true });
    try {
      await a.request.post('/api/push/prefs', { headers: { origin: BASE }, data: { newRequests: false, myUpdates: true } });
      const one = await a.newPage();
      await openApp(one);
      await one.getByTestId('account-trigger').click();
      await one.getByRole('dialog', { name: 'Account' }).getByTestId('alerts-menu').click();
      const sheet = one.getByRole('dialog', { name: 'Alerts' });
      await expect(sheet.getByRole('heading', { name: 'Alerts' })).toBeVisible();
      await sheet.getByRole('switch', { name: /Updates on my requests/ }).click();
      await sheet.getByRole('switch', { name: /New requests/ }).click();
      await expect(sheet.getByRole('switch', { name: /New requests/ })).toHaveAttribute('aria-checked', 'true');
      await expect(sheet.getByRole('switch', { name: /Updates on my requests/ })).toHaveAttribute('aria-checked', 'false');

      const two = await b.newPage();
      await openApp(two);
      await two.getByTestId('account-trigger').click();
      await two.getByRole('dialog', { name: 'Account' }).getByTestId('alerts-menu').click();
      const other = two.getByRole('dialog', { name: 'Alerts' });
      await expect(other.getByRole('switch', { name: /New requests/ })).toHaveAttribute('aria-checked', 'true');
      await expect(other.getByRole('switch', { name: /Updates on my requests/ })).toHaveAttribute('aria-checked', 'false');
      // The phone bell follows the server switch.
      await expect.poll(() => two.evaluate(() => localStorage.getItem('lp-bell'))).toBe('1');
    } finally {
      await a.request.post('/api/push/prefs', { headers: { origin: BASE }, data: { newRequests: false, myUpdates: true } });
      await a.close();
      await b.close();
    }
  });
});

test.describe('overflow: the banner and the Alerts sheet at every width', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Layout is checked once, in Chromium.');

  for (const width of OVERFLOW_WIDTHS) {
    test(`${width} px`, async ({ browser }) => {
      const phone = width < 768;
      const kinds: Array<[string, 'iphone' | 'desktop' | 'ipad', FakePushOptions]> = phone
        ? [
            ['install', 'iphone', { permission: 'default', noPush: true }],
            ['off', 'iphone', { permission: 'default', standalone: true }],
            ['blocked', 'iphone', { permission: 'denied', standalone: true }],
          ]
        : [
            ['install', 'ipad', { permission: 'default', noPush: true }],
            ['off', 'desktop', { permission: 'default' }],
            ['blocked', 'desktop', { permission: 'denied' }],
          ];
      for (const [state, kind, push] of kinds) {
        const ctx = await context(browser, PHONE, kind, push, { viewport: { width, height: phone ? 844 : 900 } });
        try {
          const page = await ctx.newPage();
          await openApp(page);
          const b = banner(page);
          await expect(b).toBeVisible({ timeout: 20_000 });
          await expect(b).toHaveAttribute('data-state', state);
          await expectNoOverflow(page, b, `banner (${state})`);
          if (state === 'blocked') {
            // The Alerts sheet, from the avatar menu (phone) or the desk's Alerts item.
            if (phone) {
              await page.getByTestId('account-trigger').click();
              await page.getByRole('dialog', { name: 'Account' }).getByTestId('alerts-menu').click();
            } else {
              await page.locator('[data-testid="desk-alerts"], [data-testid="desk-rail"] button[aria-label^="Alerts"]').filter({ visible: true }).first().click();
            }
            const sheet = page.getByTestId('alerts-sheet');
            await expectNoOverflow(page, sheet, 'Alerts sheet');
          }
        } finally {
          await ctx.close();
        }
      }
    });
  }
});
