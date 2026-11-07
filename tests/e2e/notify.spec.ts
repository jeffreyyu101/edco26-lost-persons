import { randomUUID } from 'node:crypto';
import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { RequestDetail, RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { newSignedInContext, signedInAs } from './helpers/session';

// System notifications for alerts (v2.5 A52, design/DECISIONS.md v2.2 row 10): on a desktop, an alert
// raised while the page is hidden (or the window is not focused) is a system notification through the
// service worker registration, and the page in front keeps the toast + chime; never both. Permission is
// asked only from a tap, denied is a quiet "Blocked in browser", and the iPhone layout is unchanged.
//
// Chromium, desktop context: context.grantPermissions(['notifications']) and a spy on
// ServiceWorkerRegistration.prototype.showNotification (nothing is really shown). Playwright can't
// minimise a window, so the page's visibility and focus are overridden in place (and the events fired); a
// hidden tab polls once a minute, so the test asks for a sync with an `online` event. Two pages of one
// context are two windows of one browser: never a toast in one and a notification in the other. The other
// phone logs synthetic requests (TEST-N-<tag>), closed again after each test.
//
// F4: these desktop contexts have no Web Push (PushManager is removed), which is the "no subscription →
// today's system notifications" case; the push cases are in alerts.spec.ts. "New requests" is the server-side
// switch (POST /api/push/prefs), opened from Alerts in the avatar menu.

const BASE = testBaseUrl();
const LIAISON = { staffName: 'TEST-N Notify', team: 'Medical' };
const FRONT = { staffName: 'TEST-N Front', team: 'GC/HX - Dispatch' };
const TAG = `TEST-N-${Date.now().toString(36)}`;
const PHONE = '407-555-0100';
let seq = 0;

type Mode = 'granted' | 'denied' | 'default';

interface Shown {
  title: string;
  body?: string;
  tag?: string;
  renotify?: boolean;
  requireInteraction?: boolean;
  data?: { url?: string; key?: string | null };
}

declare global {
  interface Window {
    __lpShown: Shown[];
    __lpAsked: number;
    __lpAnswer: NotificationPermission;
    __lpBackground: (hidden: boolean, focused: boolean) => void;
  }
}

/** Spy on showNotification, count permission prompts, and let the test hide or blur the page. */
async function installSpy(context: BrowserContext, mode: Mode): Promise<void> {
  await context.addInitScript((m: Mode) => {
    const w = window;
    w.__lpShown = [];
    w.__lpAsked = 0;
    w.__lpAnswer = 'granted';
    // No Web Push here (F4): the page's own system notifications are what these tests check.
    delete (window as unknown as { PushManager?: unknown }).PushManager;
    if (typeof ServiceWorkerRegistration !== 'undefined') {
      ServiceWorkerRegistration.prototype.showNotification = function (title: string, options?: NotificationOptions) {
        w.__lpShown.push(JSON.parse(JSON.stringify({ title, ...(options ?? {}) })) as Shown);
        return Promise.resolve();
      };
      ServiceWorkerRegistration.prototype.getNotifications = function () {
        return Promise.resolve([]);
      };
    }
    if (typeof Notification !== 'undefined') {
      const real = Notification.requestPermission.bind(Notification);
      let permission: NotificationPermission | null = m === 'granted' ? null : m;
      // Chromium's headless shell keeps Notification.permission at 'denied' even after
      // context.grantPermissions(['notifications']) (the Permissions API does say 'granted'): mirror the grant.
      if (m === 'granted' && Notification.permission !== 'granted') permission = 'granted';
      if (permission !== null) Object.defineProperty(Notification, 'permission', { configurable: true, get: () => permission });
      Notification.requestPermission = () => {
        w.__lpAsked += 1;
        if (permission === null) return real();
        if (permission === 'default') permission = w.__lpAnswer;
        return Promise.resolve(permission);
      };
    }
    w.__lpBackground = (hidden: boolean, focused: boolean) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.hasFocus = () => focused;
      // What the browser would say, so the app hears it (the front claim across tabs follows these).
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event(focused ? 'focus' : 'blur'));
    };
  }, mode);
}

/** The liaison on a laptop (desktop Chrome), Alerts optionally on. */
async function desktop(browser: Browser, mode: Mode, opts: { bell?: boolean } = {}): Promise<BrowserContext> {
  const d = devices['Desktop Chrome'];
  const context = await newSignedInContext(browser, LIAISON, {
    baseURL: BASE,
    viewport: d.viewport,
    userAgent: d.userAgent,
    deviceScaleFactor: d.deviceScaleFactor,
    isMobile: false,
    hasTouch: false,
  });
  if (mode === 'granted') await context.grantPermissions(['notifications'], { origin: BASE });
  await installSpy(context, mode);
  // "New requests" is server-side (F4): set it for this identity, on or off, before the app opens.
  const res = await context.request.post('/api/push/prefs', { headers: { origin: BASE }, data: { newRequests: !!opts.bell } });
  expect(res.status(), await res.text()).toBe(200);
  if (opts.bell) {
    await context.addInitScript(() => {
      localStorage.setItem('lp-bell', '1');
      localStorage.setItem('lp-bell-intro-seen', '1');
    });
  }
  return context;
}

const lp = (r: RequestSummary) => `LP-${String(r.caseNumber).padStart(4, '0')}`;
/** The page's list has the row: its sync applied it (alerting, or not, on the way). */
const synced = (page: Page, r: RequestSummary) => expect(page.locator(`[data-request-id="${r.id}"]`).first()).toBeAttached({ timeout: 15_000 });
/** The front claim across the browser's app tabs (lib/client/system-notify.ts FRONT_KEY). */
const frontClaim = (page: Page) => page.evaluate(() => localStorage.getItem('lp-alerts-front'));
const shownFor = (page: Page, id: string) => page.evaluate((tag) => window.__lpShown.filter((n) => n.tag === tag), `lp-${id}`);
const toastFor = (page: Page, r: RequestSummary) => page.locator('.lp-toast').filter({ hasText: `New request · ${lp(r)}` });
/** A hidden tab polls once a minute: sync now. */
const syncNow = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('online')));

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 15_000 });
}

/** Front of house logs a request (someone else's, so the liaison's bell alerts it). */
async function logRequest(front: BrowserContext, created: RequestSummary[]): Promise<RequestSummary> {
  seq += 1;
  const res = await front.request.post('/api/requests', {
    headers: { origin: BASE },
    data: {
      clientMutationId: randomUUID(),
      reportingLocation: 'FA 3 – Kinetic',
      name: `${TAG} N${seq}`,
      age: 21,
      gender: 'Female',
      clothing: `Synthetic ${TAG} jacket ${seq}`,
      contactName: `${TAG} Friend`,
      contactPhone: PHONE,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const request = ((await res.json()) as { request: RequestSummary }).request;
  created.push(request);
  return request;
}

async function closeAll(front: BrowserContext, created: RequestSummary[]): Promise<void> {
  for (const r of created.splice(0)) {
    try {
      const row = (await (await front.request.get(`/api/requests/${r.id}`)).json()) as RequestDetail;
      if (row.status === 'Added') await front.request.post(`/api/requests/${r.id}/cancel`, { headers: { origin: BASE }, data: { expectedVersion: row.rowVersion } });
    } catch {
      // best effort
    }
  }
}

let errors: string[];
const watch = (page: Page) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
};

signedInAs(LIAISON);

test.beforeEach(() => {
  errors = [];
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test.describe('desktop (Chromium)', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Desktop system notifications are checked in Chromium.');

  test('a hidden page notifies (no toast); a visible page toasts (no notification); a blurred window notifies', async ({ browser }) => {
    test.slow();
    const desk = await desktop(browser, 'granted', { bell: true });
    const front = await newSignedInContext(browser, FRONT, { baseURL: BASE });
    const created: RequestSummary[] = [];
    try {
      const page = await desk.newPage();
      watch(page);
      await openApp(page);
      // The grant is real for this origin (see installSpy for the headless-shell getter).
      expect(await page.evaluate(() => navigator.permissions.query({ name: 'notifications' }).then((s) => s.state))).toBe('granted');
      // Once the service worker is active the menu shows the granted state (no "Allow" button).
      await page.getByTestId('account-trigger').filter({ visible: true }).click();
      const menu = page.getByRole('dialog', { name: 'Account' });
      await expect(menu.getByTestId('notify-state')).toHaveAttribute('data-state', 'granted', { timeout: 30_000 });
      await expect(menu.getByTestId('notify-state')).toHaveText('System notifications on');
      await expect(menu.getByTestId('notify-allow')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);

      // Minimised: a new request by someone else is one system notification, and no toast.
      await page.evaluate(() => window.__lpBackground(true, false));
      const hidden = await logRequest(front, created);
      await syncNow(page);
      await expect.poll(() => shownFor(page, hidden.id), { timeout: 15_000 }).toHaveLength(1);
      const [n] = await shownFor(page, hidden.id);
      expect(n).toMatchObject({
        title: `New request · ${lp(hidden)}`,
        body: 'T.N. · FA 3',
        tag: `lp-${hidden.id}`,
        renotify: true,
        data: { url: `/?r=${hidden.id}`, key: `${hidden.id}:${hidden.rowVersion}` },
      });
      // Lock screen / notification centre: never the phone number, the contact or the name.
      expect(JSON.stringify(n)).not.toContain('555');
      expect(JSON.stringify(n)).not.toContain(`${TAG} Friend`);
      expect(JSON.stringify(n)).not.toContain(`${TAG} N`);
      await expect(toastFor(page, hidden)).toHaveCount(0);
      // The next polls re-deliver the row: still one notification (the (id, rowVersion) dedupe).
      await syncNow(page);
      await page.waitForTimeout(1_500);
      expect(await shownFor(page, hidden.id)).toHaveLength(1);

      // In front again: the toast (and chime), no notification.
      await page.evaluate(() => window.__lpBackground(false, true));
      const visible = await logRequest(front, created);
      await syncNow(page);
      await expect(toastFor(page, visible)).toBeVisible({ timeout: 15_000 });
      expect(await shownFor(page, visible.id)).toEqual([]);

      // Visible but another window has the focus (desktop): a system notification.
      await page.evaluate(() => window.__lpBackground(false, false));
      const blurred = await logRequest(front, created);
      await syncNow(page);
      await expect.poll(() => shownFor(page, blurred.id), { timeout: 15_000 }).toHaveLength(1);
      await expect(toastFor(page, blurred)).toHaveCount(0);
    } finally {
      await closeAll(front, created);
      await front.close();
      await desk.close();
    }
  });

  test('two windows of one browser: the focused one toasts, the other shows nothing; all in the background, one notification', async ({ browser }) => {
    test.slow();
    const desk = await desktop(browser, 'granted', { bell: true });
    const front = await newSignedInContext(browser, FRONT, { baseURL: BASE });
    const created: RequestSummary[] = [];
    try {
      const list = await desk.newPage();
      watch(list);
      await openApp(list);
      const other = await desk.newPage();
      watch(other);
      await openApp(other);
      // Both have system notifications on (their worker answers lp-caps).
      for (const page of [list, other]) {
        await page.getByTestId('account-trigger').filter({ visible: true }).click();
        const menu = page.getByRole('dialog', { name: 'Account' });
        await expect(menu.getByTestId('notify-state')).toHaveAttribute('data-state', 'granted', { timeout: 30_000 });
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
      }
      // A second window, visible but without the focus (the dashboard on another monitor); the list in front.
      await other.evaluate(() => window.__lpBackground(false, false));
      await list.evaluate(() => window.__lpBackground(false, true));
      await expect.poll(() => frontClaim(other)).not.toBeNull();

      // The other window syncs first: nothing there. The list syncs: its toast.
      const r1 = await logRequest(front, created);
      await syncNow(other);
      await synced(other, r1);
      await syncNow(list);
      await expect(toastFor(list, r1)).toBeVisible({ timeout: 15_000 });
      await other.waitForTimeout(1_500);
      expect(await shownFor(other, r1.id)).toEqual([]);
      expect(await shownFor(list, r1.id)).toEqual([]);
      await expect(toastFor(other, r1)).toHaveCount(0);

      // Everything in the background (minimised): one notification, from the window that syncs first;
      // the other adds neither a notification nor a toast.
      await list.evaluate(() => window.__lpBackground(true, false));
      await expect.poll(() => frontClaim(other)).toBeNull();
      const r2 = await logRequest(front, created);
      await syncNow(list);
      await expect.poll(() => shownFor(list, r2.id), { timeout: 15_000 }).toHaveLength(1);
      await syncNow(other);
      await synced(other, r2);
      await other.waitForTimeout(1_500);
      expect(await shownFor(other, r2.id)).toEqual([]);
      await expect(toastFor(other, r2)).toHaveCount(0);
      await expect(toastFor(list, r2)).toHaveCount(0);
    } finally {
      await closeAll(front, created);
      await front.close();
      await desk.close();
    }
  });

  test('denied: a quiet "Blocked in browser", never prompted, and alerts stay toasts even when hidden', async ({ browser }) => {
    test.slow();
    const desk = await desktop(browser, 'denied');
    const front = await newSignedInContext(browser, FRONT, { baseURL: BASE });
    const created: RequestSummary[] = [];
    try {
      const page = await desk.newPage();
      watch(page);
      await openApp(page);
      await page.getByTestId('account-trigger').filter({ visible: true }).click();
      const menu = page.getByRole('dialog', { name: 'Account' });
      const state = menu.getByTestId('notify-state');
      await expect(state).toHaveAttribute('data-state', 'denied', { timeout: 30_000 });
      await expect(state).toContainText('Blocked in browser');
      await expect(menu.getByTestId('notify-allow')).toHaveCount(0);

      // New requests on (the Alerts sheet) never prompts again; the sheet shows the same quiet state, no
      // Home Screen tip.
      await menu.getByTestId('alerts-menu').click();
      const sheet = page.getByRole('dialog', { name: 'Alerts' });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByTestId('notify-state')).toHaveAttribute('data-state', 'denied');
      await expect(sheet.getByText('Add to Home Screen', { exact: true })).toHaveCount(0);
      await sheet.getByRole('switch', { name: /New requests/ }).click();
      await expect(sheet.getByRole('switch', { name: /New requests/ })).toHaveAttribute('aria-checked', 'true');
      expect(await page.evaluate(() => window.__lpAsked)).toBe(0);
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);

      await page.evaluate(() => window.__lpBackground(true, false));
      const r = await logRequest(front, created);
      await syncNow(page);
      await expect(toastFor(page, r)).toHaveCount(1, { timeout: 15_000 });
      expect(await page.evaluate(() => window.__lpShown)).toEqual([]);
    } finally {
      await closeAll(front, created);
      await front.close();
      await desk.close();
    }
  });

  test('not asked yet: nothing on load; New requests never asks; "Allow notifications" asks from one tap', async ({ browser }) => {
    const desk = await desktop(browser, 'default');
    try {
      const page = await desk.newPage();
      watch(page);
      await openApp(page);
      await page.getByTestId('account-trigger').filter({ visible: true }).click();
      const menu = page.getByRole('dialog', { name: 'Account' });
      const allow = menu.getByTestId('notify-allow');
      await expect(allow).toBeVisible({ timeout: 30_000 });
      await expect(allow).toHaveText('Allow notifications');
      expect(await page.evaluate(() => window.__lpAsked)).toBe(0);

      // The Alerts sheet: New requests on and off never asks; its one-tap row asks once.
      await menu.getByTestId('alerts-menu').click();
      const sheet = page.getByRole('dialog', { name: 'Alerts' });
      await expect(sheet).toBeVisible();
      const newRequests = sheet.getByRole('switch', { name: /New requests/ });
      await newRequests.click();
      await newRequests.click();
      expect(await page.evaluate(() => window.__lpAsked)).toBe(0);
      await sheet.getByTestId('notify-allow').click();
      await expect(sheet.getByTestId('notify-state')).toHaveText('System notifications on');
      expect(await page.evaluate(() => window.__lpAsked)).toBe(1);
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);

      await page.getByTestId('account-trigger').filter({ visible: true }).click();
      await expect(menu.getByTestId('notify-state')).toHaveAttribute('data-state', 'granted');
      await expect(menu.getByTestId('notify-allow')).toHaveCount(0);
      expect(await page.evaluate(() => window.__lpAsked)).toBe(1);
    } finally {
      await desk.close();
    }
  });
});

test('iPhone (a Safari tab): the avatar menu and the Alerts sheet show the Home Screen taps, and nothing prompts', async ({ page, context }) => {
  await installSpy(context, 'default');
  watch(page);
  await openApp(page);
  // Give the service worker time to activate: support would have shown by now if it applied.
  await page.evaluate(() =>
    Promise.race([navigator.serviceWorker?.ready.then(() => true) ?? Promise.resolve(false), new Promise((resolve) => setTimeout(resolve, 8_000))]),
  );
  await page.getByTestId('account-trigger').filter({ visible: true }).click();
  const menu = page.getByRole('dialog', { name: 'Account' });
  await expect(menu.getByRole('button', { name: 'Alerts Off' })).toBeVisible({ timeout: 15_000 });
  await expect(menu.getByTestId('notify-allow')).toHaveCount(0);
  await expect(menu.getByTestId('notify-state')).toHaveCount(0);
  await menu.getByTestId('alerts-menu').click();
  const sheet = page.getByRole('dialog', { name: 'Alerts' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Add to Home Screen', { exact: true })).toBeVisible();
  await expect(sheet.getByTestId('notify-allow')).toHaveCount(0);
  await expect(sheet.getByTestId('notify-state')).toHaveCount(0);
  expect(await page.evaluate(() => window.__lpAsked)).toBe(0);
});
