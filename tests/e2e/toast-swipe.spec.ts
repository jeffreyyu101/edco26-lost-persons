import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { RequestDetail, RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { newSignedInContext, signedInAs } from './helpers/session';

// Swipe a toast at the top away, iPhone-banner style (Brian 2026-11-07: "i should also be able to swipe it away like
// what people would expect with iphones and notifications"; lib/client/toast-swipe.ts). iPhone 14 in Chromium and
// WebKit:
//   up / sideways  the toast follows the finger (and fades); past the threshold it goes, the other toast stays
//   short / down   a short drag springs back and the toast stays; a drag down does nothing; a quick flick goes
//   taps           a tap on View still opens the request; a swipe that began on View never does
//   the page       a finger on a toast never scrolls the page (touch-action: none; its touchmoves cancelled once
//                  it follows the finger, never inside the slop, which on iOS can cost a tap its click; real touch:
//                  Chromium); a finger anywhere else still scrolls it
//   mouse          a mouse drag never moves it (click and ✕ close it); reduced motion: the same, at once
// The toasts are the sticky "<LP> · <name> located" alerts (View): synthetic requests (TEST-TS-…) logged by this
// phone and answered In medical by another staff member, closed afterwards. Synthetic touch is pointer events plus
// the touch events the browser would send (as tests/e2e/helpers/swipe.ts); real touch goes through DevTools.

const BASE = testBaseUrl();
const STAFF = { staffName: 'TEST-TS Toasts', team: 'Medical' };
const MEDIC = { staffName: 'TEST-TS Medic', team: 'Medical' };
const TAG = `TEST-TS-${Date.now().toString(36)}`;
let seq = 0;

test.use({ serviceWorkers: 'block' });
signedInAs(STAFF);

const created: Array<{ id: string; request: APIRequestContext }> = [];
let medic: BrowserContext | null = null;

async function call<T>(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

test.afterEach(async () => {
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await call<RequestDetail>(request, 'GET', `/api/requests/${id}`);
      if (row.status === 'Found – Awaiting Reunion')
        await request.fetch(`/api/requests/${id}/status`, { method: 'POST', data: { status: 'Reunited – Closed', expectedVersion: row.rowVersion, kind: 'reunite' }, headers: { Origin: BASE } });
      else if (row.status === 'Added') await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: BASE } });
    } catch {
      // Best effort.
    }
  }
  await medic?.close();
  medic = null;
});

const lp = (r: RequestSummary) => `LP-${String(r.caseNumber).padStart(4, '0')}`;

/**
 * Opens the app with `n` sticky alert toasts on it: requests this phone logged, answered In medical by the medic,
 * raised by one sync (two at most: three would combine into "3 updates").
 */
async function openWithToasts(page: Page, browser: Browser, n: 1 | 2): Promise<{ toasts: Locator[]; requests: RequestSummary[] }> {
  const requests: RequestSummary[] = [];
  for (let i = 0; i < n; i += 1) {
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
    requests.push(request);
  }
  await page.goto('/');
  for (const r of requests) await expect(page.locator(`[data-request-id="${r.id}"]`).first()).toBeAttached({ timeout: 15_000 });
  medic ??= await newSignedInContext(browser, MEDIC, { baseURL: BASE });
  for (const r of requests) await call(medic.request, 'POST', `/api/requests/${r.id}/status`, { status: 'Found – Awaiting Reunion', expectedVersion: r.rowVersion, kind: 'answer' });
  // Sync now (no waiting for the next poll).
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const toasts = requests.map((r) => page.locator('.lp-toast').filter({ hasText: `${lp(r)} · ` }));
  for (const t of toasts) await expect(t).toBeVisible({ timeout: 15_000 });
  // Their slide-in is over, and the gesture code is attached (it loads once a toast shows).
  await expect.poll(() => toasts[0]!.evaluate((el) => el.getAnimations().length)).toBe(0);
  await page.waitForTimeout(300);
  return { toasts, requests };
}

interface SwipeOptions {
  /** How long the moves take (ms). */
  ms?: number;
  steps?: number;
  /** Held still this long before letting go (ms): no flick, the distance alone decides. */
  hold?: number;
  /** Then a click on the element, as a browser may still send after a touch: at once, or this many ms later (on touch
   *  it comes in a later task). */
  click?: boolean | number;
}

interface SwipeResult {
  /** Per move: whether the page cancelled that touchmove (the browser would not scroll under it). */
  cancelled: boolean[];
  /** The toast's translate (px) and opacity just before the finger let go. */
  x: number;
  y: number;
  opacity: number;
}

/** A synthetic touch swipe from the element's centre by (dx, dy). */
async function swipe(el: Locator, dx: number, dy: number, { ms = 240, steps = 10, hold = 0, click = false }: SwipeOptions = {}): Promise<SwipeResult> {
  return el.evaluate(
    async (node, o) => {
      const box = node.getBoundingClientRect();
      const x0 = box.left + box.width / 2;
      const y0 = box.top + box.height / 2;
      const id = 43;
      const pointer = (type: string, clientX: number, clientY: number) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: id,
          pointerType: 'touch',
          isPrimary: true,
          clientX,
          clientY,
          button: type === 'pointermove' ? -1 : 0,
          buttons: type === 'pointerup' ? 0 : 1,
        });
      const touch = (type: string, clientX: number, clientY: number) => {
        const ev = new Event(type, { bubbles: true, cancelable: true, composed: true });
        const point = [{ clientX, clientY, identifier: id, target: node }];
        const down = type === 'touchend' ? [] : point;
        Object.defineProperties(ev, { touches: { value: down }, targetTouches: { value: down }, changedTouches: { value: point } });
        return ev;
      };
      const sleep = (t: number) => new Promise((r) => setTimeout(r, t));
      node.dispatchEvent(pointer('pointerdown', x0, y0));
      node.dispatchEvent(touch('touchstart', x0, y0));
      const cancelled: boolean[] = [];
      for (let i = 1; i <= o.steps; i += 1) {
        await sleep(o.ms / o.steps);
        const x = x0 + (o.dx * i) / o.steps;
        const y = y0 + (o.dy * i) / o.steps;
        node.dispatchEvent(pointer('pointermove', x, y));
        cancelled.push(!node.dispatchEvent(touch('touchmove', x, y)));
      }
      if (o.hold > 0) await sleep(o.hold);
      const toast = node.closest('.lp-toast') ?? node;
      const m = new DOMMatrixReadOnly(getComputedStyle(toast).transform);
      const result = { cancelled, x: m.m41, y: m.m42, opacity: Number(getComputedStyle(toast).opacity) };
      node.dispatchEvent(pointer('pointerup', x0 + o.dx, y0 + o.dy));
      node.dispatchEvent(touch('touchend', x0 + o.dx, y0 + o.dy));
      if (typeof o.click === 'number') await sleep(o.click);
      if (o.click !== false) node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
      return result;
    },
    { dx, dy, ms, steps, hold, click },
  );
}

/** A real touch drag from (x, y) by (dx, dy), through DevTools (Chromium only); the browser scrolls when the page lets it. */
async function realTouch(page: Page, x: number, y: number, dx: number, dy: number, { ms = 320, steps = 12, hold = 0 }: SwipeOptions = {}): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= steps; i += 1) {
      await page.waitForTimeout(ms / steps);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }] });
    }
    if (hold > 0) await page.waitForTimeout(hold);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

const transform = (el: Locator) =>
  el.evaluate((node) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(node).transform);
    return { x: m.m41, y: m.m42 };
  });
const opened = (page: Page) => new URL(page.url()).searchParams.get('r');
/** Every touchmove from the one where the toast began to follow the finger on was cancelled, none before it. */
const cancelledOnceClaimed = (c: boolean[]) => {
  const from = c.indexOf(true);
  return from >= 0 && c.slice(0, from).every((x) => !x) && c.slice(from).every(Boolean);
};

test('swipe up: it follows the finger and fades, and past the threshold it goes; the other toast stays', async ({ page, browser }) => {
  const { toasts } = await openWithToasts(page, browser, 2);
  const [first, second] = toasts as [Locator, Locator];
  const up = await swipe(second, 0, -70, { hold: 150 });
  // The first move (7 px) is inside the slop: left alone, so a tap that wobbles keeps its click on iOS.
  expect(cancelledOnceClaimed(up.cancelled), 'cancelled once it follows the finger, never inside the slop').toBe(true);
  expect(up.cancelled[0], 'the 7 px first move').toBe(false);
  expect(up.y).toBeLessThan(-40);
  expect(up.x).toBe(0);
  expect(up.opacity).toBeLessThan(1);
  await expect(second).toHaveCount(0);
  await expect(first).toBeVisible();
  expect(await transform(first)).toEqual({ x: 0, y: 0 });
  expect(opened(page), 'nothing was opened').toBeNull();

  // A quick flick up, however short, goes too.
  await swipe(first, 0, -30, { ms: 30, steps: 3 });
  await expect(first).toHaveCount(0);
});

test('swipe sideways, right or left: it follows the finger and goes', async ({ page, browser }) => {
  const { toasts } = await openWithToasts(page, browser, 2);
  const [first, second] = toasts as [Locator, Locator];
  const right = await swipe(first, 220, 6, { hold: 150 });
  expect(cancelledOnceClaimed(right.cancelled)).toBe(true);
  expect(right.x).toBeGreaterThan(180);
  expect(right.y).toBe(0);
  expect(right.opacity).toBeLessThan(1);
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();

  const left = await swipe(second, -220, -6, { hold: 150 });
  expect(left.x).toBeLessThan(-180);
  await expect(second).toHaveCount(0);
  expect(opened(page)).toBeNull();
});

test('a short drag springs back and the toast stays; a drag down does nothing; a tap still closes it', async ({ page, browser }) => {
  const { toasts } = await openWithToasts(page, browser, 1);
  const toast = toasts[0]!;
  const shortUp = await swipe(toast, 0, -18, { hold: 150 });
  expect(shortUp.y).toBeLessThan(0);
  await expect(toast).toBeVisible();
  await expect.poll(() => transform(toast)).toEqual({ x: 0, y: 0 });

  const shortSide = await swipe(toast, 90, 0, { hold: 150 });
  expect(shortSide.x).toBeGreaterThan(60);
  await expect(toast).toBeVisible();
  await expect.poll(() => transform(toast)).toEqual({ x: 0, y: 0 });
  expect(await toast.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

  const down = await swipe(toast, 0, 120, { hold: 100 });
  expect(down).toMatchObject({ x: 0, y: 0, opacity: 1 });
  // Not claimed, so not cancelled: touch-action: none keeps the page still (real touch: the Chromium test below).
  expect(down.cancelled.some(Boolean)).toBe(false);
  expect(await toast.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
  await expect(toast).toBeVisible();

  // A tap closes it, as before.
  await toast.locator('div').filter({ hasText: `${TAG} P` }).first().tap();
  await expect(toast).toHaveCount(0);
  expect(opened(page)).toBeNull();
});

test('a tap on View still opens the request; a swipe that began on View never does', async ({ page, browser }) => {
  const { toasts, requests } = await openWithToasts(page, browser, 2);
  const [first, second] = toasts as [Locator, Locator];
  const view = (t: Locator) => t.getByRole('button', { name: 'View' });

  // Short, from View, and the click a browser could send after it, at once or (touch) a moment later: swallowed; the
  // toast springs back.
  await swipe(view(first), 0, -16, { hold: 150, click: true });
  await expect(first).toBeVisible();
  expect(opened(page)).toBeNull();
  await swipe(view(first), 0, -16, { hold: 150, click: 250 });
  await expect(first).toBeVisible();
  expect(opened(page)).toBeNull();
  // Up and away from View: gone, nothing opened.
  await swipe(view(first), 0, -70, { hold: 150, click: true });
  await expect(first).toHaveCount(0);
  expect(opened(page)).toBeNull();

  // A tap on View: the request opens (and the toast closes).
  await view(second).tap();
  await expect.poll(() => opened(page)).toBe(requests[1]!.id);
  await expect(second).toHaveCount(0);
});

test('a finger anywhere but a toast is the page’s: its touchmoves are never cancelled; on a toast, once it follows the finger', async ({ page, browser }) => {
  const { toasts } = await openWithToasts(page, browser, 1);
  const toast = toasts[0]!;
  const box = (await toast.boundingBox())!;
  const vh = page.viewportSize()!.height;
  const outside = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x!, y!)!;
      const ev = new Event('touchmove', { bubbles: true, cancelable: true, composed: true });
      const point = [{ clientX: x, clientY: y, identifier: 7, target: el }];
      Object.defineProperties(ev, { touches: { value: point }, targetTouches: { value: point }, changedTouches: { value: point } });
      return { inToast: !!el.closest('.lp-toast'), passed: el.dispatchEvent(ev) };
    },
    [box.x + box.width / 2, vh * 0.7],
  );
  expect(outside, 'a touchmove away from the toast is left to the browser').toEqual({ inToast: false, passed: true });
  expect(await toast.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
  // On the toast, a drag down moves nothing and claims nothing (touch-action: none keeps the page still).
  const down = await swipe(toast, 0, 120, { hold: 60 });
  expect(down.cancelled.some(Boolean)).toBe(false);
  await expect(toast).toBeVisible();
  // A short drag up: the move inside the slop is left alone, the rest cancelled.
  const short = await swipe(toast, 0, -24, { steps: 6, hold: 150 });
  expect(cancelledOnceClaimed(short.cancelled)).toBe(true);
  await expect(toast).toBeVisible();
});

test('real touch (Chromium): the page scrolls under a finger outside the toast, never under one on it', async ({ page, browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real touch input through DevTools is Chromium only.');
  const { toasts } = await openWithToasts(page, browser, 1);
  const toast = toasts[0]!;
  // Room to scroll, whatever the list holds.
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div data-test-spacer style="height:2400px"></div>'));
  const box = (await toast.boundingBox())!;
  const vh = page.viewportSize()!.height;

  // A drag up from the middle of the screen scrolls the page; the toast stays where it is.
  await realTouch(page, box.x + box.width / 2, vh * 0.75, 0, -260, { hold: 80 });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  await expect(toast).toBeVisible();
  expect(await transform(toast)).toEqual({ x: 0, y: 0 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  // On the toast: a drag down neither scrolls nor moves anything; a drag up takes the toast away, not the page.
  const at = (await toast.boundingBox())!;
  await realTouch(page, at.x + at.width / 3, at.y + at.height / 2, 0, 200, { hold: 80 });
  await expect(toast).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await realTouch(page, at.x + at.width / 3, at.y + at.height / 2, 0, -60, { hold: 120 });
  await expect(toast).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(opened(page)).toBeNull();
});

test('real touch (Chromium): a tap on View that wobbles a little still opens it; a short swipe from View never does', async ({ page, browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real touch input through DevTools is Chromium only.');
  const { toasts, requests } = await openWithToasts(page, browser, 2);
  const [first, second] = toasts as [Locator, Locator];
  const view = (t: Locator) => t.getByRole('button', { name: 'View' });
  // 11 px up from View: the toast follows, springs back, and the browser's later tap-click on View is swallowed.
  const a = (await view(first).boundingBox())!;
  await realTouch(page, a.x + a.width / 2, a.y + a.height / 2, 0, -11, { ms: 120, steps: 4, hold: 40 });
  await page.waitForTimeout(400);
  expect(opened(page), 'a swipe from View opened nothing').toBeNull();
  await expect(first).toBeVisible();
  // A tap that moves 3 px (inside the slop): View runs.
  const b = (await view(second).boundingBox())!;
  await realTouch(page, b.x + b.width / 2, b.y + b.height / 2, 3, 2, { ms: 60, steps: 2 });
  await expect.poll(() => opened(page)).toBe(requests[1]!.id);
});

test('a mouse drag is not a swipe: it never moves the toast (a mouse press and release on it is a click; ✕ closes)', async ({ page, browser }) => {
  const { toasts } = await openWithToasts(page, browser, 2);
  const [first, second] = toasts as [Locator, Locator];
  const box = (await first.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 60, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, y, { steps: 8 });
  expect(await transform(first), 'it never followed the mouse').toEqual({ x: 0, y: 0 });
  await page.mouse.move(box.x + 30, y, { steps: 8 });
  expect(await transform(first)).toEqual({ x: 0, y: 0 });
  await page.mouse.up();
  // Pressed and released on it: a click, which closes it as before.
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();
  await second.getByRole('button', { name: 'Dismiss' }).click();
  await expect(second).toHaveCount(0);
});

test('reduced motion: the same swipes, with no slide (gone or back at once)', async ({ page, browser }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { toasts } = await openWithToasts(page, browser, 2);
  const [first, second] = toasts as [Locator, Locator];
  const short = await swipe(first, 90, 0, { hold: 150 });
  expect(short.x).toBeGreaterThan(60);
  // Back at once (no spring; the app's reduced-motion rule leaves transitions 0.01 ms).
  await expect.poll(() => transform(first), { timeout: 150, intervals: [16] }).toEqual({ x: 0, y: 0 });
  await swipe(first, 0, -70, { hold: 150 });
  await expect(first).toHaveCount(0, { timeout: 150 });
  await swipe(second, -220, 0, { hold: 150 });
  await expect(second).toHaveCount(0, { timeout: 150 });
});
