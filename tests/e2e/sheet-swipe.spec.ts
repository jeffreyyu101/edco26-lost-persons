import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ActivityRow } from '../../lib/activity';
import type { RequestDetail, RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { smallTargets } from './helpers/a11y';
import { expectNoOverflow } from './helpers/overflow';
import { signedInAs } from './helpers/session';
import { realTouchSwipe, swipe } from './helpers/swipe';

// Swipe a phone sheet down to close it (hotfix 2026-11-07, Brian on the iPhone Home Screen app: the Activity sheet
// "doesn't easily scroll away, I can't drag and close it easily"; lib/client/sheet-swipe.ts). iPhone 14 in
// Chromium and WebKit:
//   Activity  ✕ in its header (44 px, beside Mark all read) and the strip of dimmed page above it close it, focus
//             back on the bell; a drag on the grabber follows the finger, springs back when short, closes past a
//             quarter of the height or on a flick; in the list, a drag down is the list's while it is scrolled
//             and the sheet's at the top; reduced motion: the same, without the animations
//   location  the same swipe closes it with nothing saved, never from inside its field; with the keyboard up the
//             field lets go first (the keyboard goes) and the page behind is unpinned
// The Activity list is the server's answer replaced by 30 synthetic rows (so it scrolls); the location sheet runs
// on a synthetic request (TEST-SW-…), closed afterwards. Real touch (scrolling included) is checked in Chromium.

const BASE = testBaseUrl();
const STAFF = { staffName: 'TEST-SW Sheets', team: 'Medical' };
const TAG = `TEST-SW-${Date.now().toString(36)}`;
let seq = 0;

test.use({ serviceWorkers: 'block' });
signedInAs(STAFF);

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function call<T>(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function inMedicalRequest(page: Page): Promise<RequestSummary> {
  seq += 1;
  const { request } = await call<{ request: RequestSummary }>(page.request, 'POST', '/api/requests', {
    clientMutationId: randomUUID(),
    reportingLocation: 'FA 3 – Kinetic',
    name: `${TAG} P${seq}`,
    age: '22',
    gender: 'Female',
    clothing: `Synthetic ${TAG} jacket`,
  });
  created.push({ id: request.id, request: page.request });
  return (await call<{ request: RequestSummary }>(page.request, 'POST', `/api/requests/${request.id}/status`, { status: 'Found – Awaiting Reunion', expectedVersion: request.rowVersion, kind: 'answer' })).request;
}

test.afterEach(async () => {
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await call<RequestDetail>(request, 'GET', `/api/requests/${id}`);
      if (row.status === 'Found – Awaiting Reunion')
        await request.fetch(`/api/requests/${id}/status`, { method: 'POST', data: { status: 'Reunited – Closed', expectedVersion: row.rowVersion, kind: 'reunite' }, headers: { Origin: BASE } });
    } catch {
      // Best effort.
    }
  }
});

/** The Activity list answers with `n` synthetic rows (read, a minute apart). */
async function mockActivity(page: Page, n: number): Promise<void> {
  const now = Date.now();
  const rows: ActivityRow[] = Array.from({ length: n }, (_, i) => ({
    requestId: randomUUID(),
    kind: 'in_medical',
    title: `${String.fromCharCode(65 + (i % 26))}.S.`,
    detail: `Located · Chair ${i + 1}`,
    at: new Date(now - i * 60_000).toISOString(),
    read: true,
  }));
  await page.route(/\/api\/activity$/, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { serverTime: new Date().toISOString(), rows } }) : route.fallback(),
  );
}

const bell = (page: Page) => page.getByTestId('activity-bell').filter({ visible: true });

async function openActivity(page: Page): Promise<{ sheet: Locator; scroller: Locator; height: number }> {
  await page.goto('/');
  await expect(page.locator('[data-view]').first()).toBeVisible({ timeout: 15_000 });
  await bell(page).click();
  const sheet = page.getByRole('dialog', { name: 'Activity' });
  await expect(sheet.getByTestId('activity-row').first()).toBeVisible({ timeout: 15_000 });
  // Its slide-in is over.
  await expect.poll(() => transformY(sheet)).toBe(0);
  return { sheet, scroller: sheet.getByTestId('activity-panel').locator('..'), height: (await sheet.boundingBox())!.height };
}

const transformY = (el: Locator) => el.evaluate((node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).m42);

test.describe('Activity sheet', () => {
  test('✕ (44 px, beside Mark all read) closes it, focus back on the bell; so does the strip of page above it', async ({ page }) => {
    await mockActivity(page, 3);
    const { sheet } = await openActivity(page);
    const close = sheet.getByRole('button', { name: 'Close Activity' });
    await expect(close).toBeFocused();
    await expect(sheet.getByRole('button', { name: 'Close Activity' })).toHaveCount(1);
    const x = (await close.boundingBox())!;
    expect(x.width).toBeGreaterThanOrEqual(44);
    expect(x.height).toBeGreaterThanOrEqual(44);
    const mark = (await sheet.getByRole('button', { name: 'Mark all read' }).boundingBox())!;
    expect(Math.abs(mark.y + mark.height / 2 - (x.y + x.height / 2))).toBeLessThan(2);
    expect(mark.x + mark.width).toBeLessThanOrEqual(x.x + 1);
    expect(await smallTargets(page, '[data-testid="activity-sheet"]')).toEqual([]);
    // A strip of dimmed page above it: at least 44 px (under the status bar in the Home Screen app) and 8 %.
    const vh = page.viewportSize()!.height;
    const top = (await sheet.boundingBox())!.y;
    expect(top).toBeGreaterThanOrEqual(Math.max(44, 0.08 * vh) - 1);
    expect(top).toBeLessThan(0.12 * vh);

    await close.click();
    await expect(sheet).toHaveCount(0);
    await expect(bell(page)).toBeFocused();

    await bell(page).click();
    // (After its slide-in: Radix listens for a tap outside a moment after it opens.)
    await expect.poll(() => transformY(sheet)).toBe(0);
    await page.mouse.click(200, top / 2);
    await expect(sheet).toHaveCount(0);
    await expect(bell(page)).toBeFocused();
  });

  test('a drag on the grabber follows the finger: short springs back, past a quarter closes, a flick closes', async ({ page }) => {
    await mockActivity(page, 30);
    let { sheet, height } = await openActivity(page);
    const grabber = () => sheet.getByTestId('activity-grabber');

    // Short: it followed, then went back; still open.
    const short = await swipe(grabber(), 80, { hold: 150 });
    expect(short.cancelled.every(Boolean), 'the browser never scrolls under the drag').toBe(true);
    expect(short.moved).toBeGreaterThan(60);
    expect(short.moved).toBeLessThanOrEqual(80);
    await expect(sheet).toBeVisible();
    await expect.poll(() => transformY(sheet)).toBe(0);

    // Past a quarter of its height, held still before letting go: closed, focus back on the bell.
    await swipe(grabber(), height * 0.32, { hold: 150 });
    await expect(sheet).toHaveCount(0);
    await expect(bell(page)).toBeFocused();

    // A flick: 70 px in 50 ms.
    ({ sheet, height } = await openActivity(page));
    await swipe(grabber(), 70, { ms: 50, steps: 5 });
    await expect(sheet).toHaveCount(0);

    // The header drags it too, even with the list scrolled down.
    ({ sheet, height } = await openActivity(page));
    await sheet.getByTestId('activity-panel').locator('..').evaluate((el) => {
      el.scrollTop = 300;
    });
    await swipe(sheet.getByRole('heading', { name: 'Activity' }), height * 0.4, { hold: 120 });
    await expect(sheet).toHaveCount(0);
  });

  test('a mouse drag is not a swipe: the sheet stays put and open (desk sheets select text and click as before)', async ({ page }) => {
    await mockActivity(page, 30);
    const { sheet, height } = await openActivity(page);
    const box = (await sheet.getByTestId('activity-grabber').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + height * 0.5, { steps: 10 });
    expect(await transformY(sheet), 'it never followed the mouse').toBe(0);
    await page.mouse.up();
    await expect(sheet).toBeVisible();
    expect(await transformY(sheet)).toBe(0);
  });

  test('in the list: scrolled down, a drag down is the list’s; at the top it pulls the sheet; up is always the list’s', async ({ page }) => {
    await mockActivity(page, 30);
    const { sheet, scroller, height } = await openActivity(page);
    await scroller.evaluate((el) => {
      el.scrollTop = 400;
    });
    const scrolled = await swipe(sheet.getByTestId('activity-row').nth(10), 200, { hold: 120 });
    expect(scrolled.cancelled.some(Boolean), 'left to the browser, which scrolls the list').toBe(false);
    expect(scrolled.moved).toBe(0);
    await expect(sheet).toBeVisible();
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(400);

    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    const up = await swipe(sheet.getByTestId('activity-row').nth(4), -150, { hold: 60 });
    expect(up.cancelled.some(Boolean)).toBe(false);
    expect(up.moved).toBe(0);
    await expect(sheet).toBeVisible();

    const pull = await swipe(sheet.getByTestId('activity-row').nth(2), height * 0.4, { hold: 120 });
    expect(pull.cancelled.every(Boolean)).toBe(true);
    expect(pull.moved).toBeGreaterThan(height * 0.3);
    await expect(sheet).toHaveCount(0);
  });

  test('real touch (Chromium): the scrolled list scrolls under a drag down; the grabber and the list at its top close it', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Real touch input through DevTools is Chromium only.');
    await mockActivity(page, 30);
    let { sheet, scroller, height } = await openActivity(page);
    await scroller.evaluate((el) => {
      el.scrollTop = 600;
    });
    const list = (await scroller.boundingBox())!;
    await realTouchSwipe(page, list.x + list.width / 2, list.y + 160, 260, { hold: 100 });
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeLessThan(450);
    await expect(sheet).toBeVisible();
    expect(await transformY(sheet)).toBe(0);

    const grab = (await sheet.getByTestId('activity-grabber').boundingBox())!;
    await realTouchSwipe(page, grab.x + grab.width / 2, grab.y + grab.height / 2, height * 0.4, { hold: 120 });
    await expect(sheet).toHaveCount(0);

    ({ sheet, scroller, height } = await openActivity(page));
    const top = (await scroller.boundingBox())!;
    await realTouchSwipe(page, top.x + top.width / 2, top.y + 120, height * 0.4, { hold: 120 });
    await expect(sheet).toHaveCount(0);
    // Nothing under the finger was opened by the drag.
    expect(new URL(page.url()).searchParams.get('r')).toBeNull();
  });

  test('reduced motion: the same thresholds, no animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockActivity(page, 30);
    const { sheet, height } = await openActivity(page);
    const short = await swipe(sheet.getByTestId('activity-grabber'), 80, { hold: 150 });
    expect(short.moved).toBeGreaterThan(60);
    // Back at once (no spring; the app's reduced-motion rule leaves transitions 0.01 ms).
    await expect.poll(() => transformY(sheet), { timeout: 150, intervals: [16] }).toBe(0);
    await swipe(sheet.getByTestId('activity-grabber'), height * 0.32, { hold: 150 });
    await expect(sheet).toHaveCount(0, { timeout: 500 });
  });

  test('nothing sticks out at 320 and 375 px', async ({ page }) => {
    await mockActivity(page, 3);
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 700 });
      const { sheet } = await openActivity(page);
      await expectNoOverflow(page, '[data-testid="activity-sheet"]', `Activity sheet ${width}`);
      await sheet.getByRole('button', { name: 'Close Activity' }).click();
      await expect(sheet).toHaveCount(0);
    }
  });
});

test.describe('location sheet', () => {
  test('a drag on it lets go of the field and closes it with nothing saved; never from inside the field', async ({ page }) => {
    const r = await inMedicalRequest(page);
    await page.goto(`/?r=${r.id}`);
    await page.getByTestId('status-block').getByTestId('location-row').click();
    const sheet = page.getByRole('dialog', { name: `${r.name} located` });
    const field = sheet.getByRole('textbox', { name: 'Location' });
    const title = sheet.getByTestId('location-title');
    await expect(field).toBeFocused();
    await field.fill('Not saved');

    // From inside the field: never the sheet's.
    const inField = await swipe(field, 160, { hold: 100 });
    expect(inField.moved).toBe(0);
    await expect(sheet).toBeVisible();
    await expect(field).toBeFocused();

    // Short: back, still open; the field let go (the keyboard goes) as the drag began.
    const short = await swipe(title, 40, { hold: 150 });
    expect(short.moved).toBeGreaterThan(20);
    await expect(sheet).toBeVisible();
    await expect(field).not.toBeFocused();
    await expect.poll(() => transformY(sheet)).toBe(0);

    // Past a quarter: closed (Skip), nothing saved.
    await swipe(title, 160, { hold: 150 });
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('status-block').getByTestId('location-row')).toHaveAccessibleName('Add location');
    const detail = await call<RequestDetail>(page.request, 'GET', `/api/requests/${r.id}`);
    expect(detail.medicalLocation).toBeNull();
  });

  // Hotfix F5.1: a sheet with a focused field sits on the keyboard and pins the page. A swipe down then lets go
  // of the field first (the sheet comes off the keyboard at once) and closes cleanly: the page unpinned, where
  // it was. Playwright shows no keyboard, so window.visualViewport is a fake sized like one.
  test('with the keyboard up: the field lets go first, then it closes; the page is unpinned where it was', async ({ page }) => {
    await page.addInitScript(() => {
      const vv = Object.assign(new EventTarget(), { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
      Object.assign(window, {
        __lpViewport: (box: { offsetTop: number; height: number }) => {
          Object.assign(vv, box);
          vv.dispatchEvent(new Event('resize'));
        },
      });
    });
    const r = await inMedicalRequest(page);
    await page.goto(`/?r=${r.id}`);
    const row = page.getByTestId('status-block').getByTestId('location-row');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => window.scrollTo(0, 80));
    const scrolled = await page.evaluate(() => window.scrollY);
    await row.click();
    const sheet = page.getByRole('dialog', { name: `${r.name} located` });
    const field = sheet.getByRole('textbox', { name: 'Location' });
    await expect(field).toBeFocused();
    const height = page.viewportSize()!.height;
    await page.evaluate((h) => (window as unknown as { __lpViewport: (b: unknown) => void }).__lpViewport({ offsetTop: 0, height: h - 300 }), height);
    const overlay = page.locator('.rt-BaseDialogOverlay').filter({ has: sheet });
    await expect(overlay).toHaveAttribute('data-kb', '');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).position)).toBe('fixed');
    await expect.poll(async () => Math.round((await sheet.boundingBox())!.y + (await sheet.boundingBox())!.height)).toBe(height - 300);

    // The field lets go while the sheet is still open (as the drag begins), not when it unmounts.
    await field.evaluate((el) =>
      el.addEventListener('blur', () => Object.assign(window, { __lpBlurWhile: el.closest('[role="dialog"]')?.getAttribute('data-state') }), { once: true }),
    );
    const drag = await swipe(sheet.getByTestId('location-title'), 160, { hold: 150 });
    expect(drag.moved).toBeGreaterThan(100);
    await expect(sheet).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __lpBlurWhile?: string }).__lpBlurWhile)).toBe('open');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).position)).not.toBe('fixed');
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
    const detail = await call<RequestDetail>(page.request, 'GET', `/api/requests/${r.id}`);
    expect(detail.medicalLocation).toBeNull();
  });
});
