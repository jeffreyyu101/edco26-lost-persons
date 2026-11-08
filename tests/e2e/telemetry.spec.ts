import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { RequestDetail, RequestSummary } from '../../lib/api-types';
import { localDbUrl, testBaseUrl } from '../../scripts/test-env.mjs';
import { sessionCookieHeader, signedInAs } from './helpers/session';
import { realTouchSwipe, swipe } from './helpers/swipe';

// In-house telemetry end to end (design/references/observability-design.md §6 E2E), iPhone 14 in Chromium and WebKit,
// on the production build: the collector loads after idle (opted in with lp-tel-test, as the gate keeps automated
// browsers quiet), and a session through the app lands in lp_tel_events with frustration signals and trails and NO
// personal data (a request named TEST-e2e Quorra Zyxwvut, phone 407 555 0199, last seen Gate Plum, the message "TEST-e2e
// secret phrase plum", a search for Quorra). Telemetry requests never start while an app request is in flight; offline
// events arrive once back online; the kill switch's 204 stops every later send; and with the telemetry route failing
// (500s, timeouts) the app behaves exactly as before. The first load carries none of it. (2026-11-08, after main's
// "Phone thread in the page") the phone's thread has no box of its own: swipes that start on it count for the page
// (area `profile`, the crumbs keep `thread`), and a real swipe there that scrolls the page is not a still one.

const BASE = testBaseUrl();
const STAFF = { staffName: 'TEST-e2e Telemetry', team: 'Medical' };
const TAG = `TEST-e2e-${Date.now().toString(36)}`;

test.use({ serviceWorkers: 'block' });
signedInAs(STAFF);

const psql = (sql: string) => execFileSync('psql', [localDbUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-c', sql], { encoding: 'utf8' }).trim();
const created: Array<{ id: string; request: APIRequestContext }> = [];

async function call<T>(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('lp-tel-test', '1');
    } catch {
      // the gate then keeps the collector off, and the test fails on its own check
    }
  });
});

test.afterEach(async () => {
  psql(`update public.lp_tel_settings set enabled = true, updated_at = now()`);
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await call<RequestDetail>(request, 'GET', `/api/requests/${id}`);
      if (row.status === 'Added') await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: BASE } });
    } catch {
      // best effort
    }
  }
});

test.afterAll(async () => {
  // The server's cached config follows the switch route at once.
  const cookie = await sessionCookieHeader(STAFF);
  await fetch(`${BASE}/api/telemetry/settings`, { method: 'POST', headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
});

async function createPiiRequest(page: Page): Promise<RequestSummary> {
  const { request } = await call<{ request: RequestSummary }>(page.request, 'POST', '/api/requests', {
    clientMutationId: randomUUID(),
    reportingLocation: 'FA 3 – Kinetic',
    name: `${TAG} Quorra Zyxwvut`,
    age: '22',
    gender: 'Female',
    clothing: 'Synthetic Gate Plum jacket',
    lastSeen: 'Gate Plum',
    contactPhone: '407 555 0199',
  });
  created.push({ id: request.id, request: page.request });
  return request;
}

/** The collector is running: its pass-through observer is window.fetch. */
async function collectorRunning(page: Page): Promise<string> {
  await page.waitForFunction(() => !/\[native code\]/.test(String(window.fetch)), null, { timeout: 25_000 });
  const device = await page.evaluate(() => window.localStorage.getItem('lp-tel-device'));
  expect(device).toMatch(/^[a-z0-9]{16}$/);
  return device as string;
}

/** The page "hides": everything waiting goes out in a beacon (the real pagehide handler). */
async function flush(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
}

const names = (device: string) => psql(`select coalesce(string_agg(distinct name, ',' order by name), '') from public.lp_tel_events where device = '${device}'`).split(',');

/** Records, for every telemetry fetch, how many other /api/* requests (not images) were in flight when it started. */
function watchOverlap(page: Page): { overlaps: number[]; telemetry: () => number; busy: () => number } {
  const inflight = new Set<unknown>();
  const overlaps: number[] = [];
  let count = 0;
  const isApi = (url: string) => new URL(url).pathname.startsWith('/api/');
  page.on('request', (r) => {
    if (!isApi(r.url())) return;
    if (new URL(r.url()).pathname === '/api/telemetry') {
      count += 1;
      if (r.resourceType() === 'fetch') overlaps.push(inflight.size);
      return;
    }
    if (r.resourceType() !== 'image') inflight.add(r);
  });
  page.on('requestfinished', (r) => inflight.delete(r));
  page.on('requestfailed', (r) => inflight.delete(r));
  return { overlaps, telemetry: () => count, busy: () => inflight.size };
}

test('a session lands in lp_tel_events with frustration signals and trails, and no personal data at all', async ({ page }) => {
  test.setTimeout(120_000);
  const started = psql('select now()::text');
  const r = await createPiiRequest(page);
  const watch = watchOverlap(page);
  await page.goto(`/?r=${r.id}`);
  await expect(page.getByTestId('profile').first()).toBeVisible({ timeout: 15_000 });
  const device = await collectorRunning(page);

  // A triple tap on something that isn't a control.
  const box = (await page.getByTestId('profile-case').first().boundingBox()) ?? { x: 40, y: 120, width: 10, height: 10 };
  for (let i = 0; i < 3; i += 1) await page.mouse.click(box.x + box.width / 2 + i, box.y + box.height / 2);

  // A message with personal text, then three swipes that start on the thread and move nothing (synthetic touches:
  // nothing scrolls), which on a phone is the page's stuck scroll.
  await page.getByTestId('composer-input').fill('TEST-e2e secret phrase plum');
  await page.getByTestId('composer-send').click();
  const thread = page.getByTestId('thread').first();
  await expect(thread).toBeVisible();
  await page.waitForTimeout(800);
  for (let i = 0; i < 3; i += 1) {
    await swipe(thread, -120, { ms: 200, steps: 6 });
    await page.waitForTimeout(500);
  }

  // A search for the name, in place (after the swipes' stillness window has passed and been processed).
  await page.waitForTimeout(1_500);
  await page.evaluate(() => window.history.pushState({}, '', '/?q=Quorra'));
  await page.waitForTimeout(1_500);
  // A hidden page beacons only while none of the app's requests is in flight: hide at such a moment.
  await expect.poll(() => watch.busy(), { timeout: 10_000, intervals: [50] }).toBe(0);
  await flush(page);

  await expect.poll(() => names(device), { timeout: 30_000 }).toEqual(expect.arrayContaining(['app_start', 'view', 'rage_tap', 'stuck_scroll', 'net']));
  const rage = psql(`select coalesce(n, 0) || '|' || jsonb_array_length(trail) from public.lp_tel_events where device = '${device}' and name = 'rage_tap' limit 1`).split('|');
  expect(Number(rage[0])).toBeGreaterThanOrEqual(3);
  expect(Number(rage[1])).toBeGreaterThan(0);
  const stuck = psql(`select area || '|' || (trail::text like '%"w!:thread:u"%') from public.lp_tel_events where device = '${device}' and name = 'stuck_scroll' limit 1`);
  expect(stuck, 'stuck scroll on the page (profile), its trail with the swipes on the thread').toBe('profile|true');
  expect(psql(`select team from public.lp_tel_devices where device = '${device}'`)).toBe('medical');

  // No personal data anywhere. Names: not in any event or the device row, as text. Digits ('0199', '555'): not in any
  // string value (timestamps, ids and durations are numbers and may hold any digits).
  const all = psql(`select coalesce(string_agg(row_to_json(e)::text, ' '), '') from public.lp_tel_events e where device = '${device}' and received_at >= '${started}'`).toLowerCase();
  const dev = psql(`select row_to_json(d)::text from public.lp_tel_devices d where device = '${device}'`).toLowerCase();
  for (const secret of ['quorra', 'zyxwvut', 'plum', 'secret', 'telemetry · medical', TAG.toLowerCase()]) {
    expect(all.includes(secret), `events contain "${secret}"`).toBe(false);
    expect(dev.includes(secret), `device row contains "${secret}"`).toBe(false);
  }
  expect(all).not.toContain(r.id);
  const values = JSON.parse(
    psql(`select coalesce(json_agg(json_build_object('name', name, 'view', view, 'area', area, 'ctl', ctl, 'team', team, 'props', props, 'trail', trail)), '[]') from public.lp_tel_events where device = '${device}' and received_at >= '${started}'`),
  ) as unknown;
  const strings: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(values);
  expect(strings.length).toBeGreaterThan(20);
  for (const str of strings) {
    expect(str, str).not.toMatch(/0199|555|\s|@/);
  }

  // No telemetry fetch ever started while an app request was in flight.
  expect(watch.telemetry()).toBeGreaterThan(0);
  expect(watch.overlaps.every((n) => n === 0), `overlaps: ${watch.overlaps.join(',')}`).toBe(true);
});

test("the phone's thread is part of the page: a real swipe that starts on it scrolls the page and is not a still swipe", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-iphone14', 'a real touch goes through DevTools (Chromium)');
  test.setTimeout(120_000);
  const r = await createPiiRequest(page);
  const watch = watchOverlap(page);
  await page.goto(`/?r=${r.id}`);
  await expect(page.getByTestId('profile').first()).toBeVisible({ timeout: 15_000 });
  const device = await collectorRunning(page);
  await page.getByTestId('composer-input').fill(`${TAG} page swipe`);
  await page.getByTestId('composer-send').click();
  const thread = page.getByTestId('thread').first();
  await expect(thread).toContainText(`${TAG} page swipe`, { timeout: 15_000 });
  const bubble = page.getByTestId('bubble-mine').last();
  await bubble.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(400);
  const box = (await bubble.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const before = await page.evaluate(() => window.scrollY);
  expect(before, 'the request page is longer than the screen').toBeGreaterThan(0);
  expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-testid="thread"]'), at), 'the finger starts on the thread').toBe(true);
  // Finger down from the bubble: the page scrolls up.
  await realTouchSwipe(page, at.x, at.y, 120, { ms: 250, steps: 8 });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.scrollY), 'the swipe scrolled the page').toBeLessThan(before);
  await page.waitForTimeout(1_500);
  await expect.poll(() => watch.busy(), { timeout: 10_000, intervals: [50] }).toBe(0);
  await flush(page);
  const swipes = () => psql(`select coalesce(string_agg(area || ':' || coalesce(props->>'still', '0'), ',' order by area), '') from public.lp_tel_events where device = '${device}' and name = 'swipe' and props->>'input' = 'touch'`);
  await expect.poll(swipes, { timeout: 30_000 }).toMatch(/profile:0/);
  expect(swipes()).not.toMatch(/thread/);
  expect(psql(`select count(*) from public.lp_tel_events where device = '${device}' and name = 'stuck_scroll'`)).toBe('0');
});

test('offline: events wait, and arrive once back online (with the link going down and up)', async ({ page, context }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const device = await collectorRunning(page);
  await context.setOffline(true);
  await page.waitForTimeout(3_000);
  // Hidden while offline: no beacon, the batch waits in IndexedDB.
  await flush(page);
  await page.waitForTimeout(500);
  await context.setOffline(false);
  await page.waitForTimeout(1_500);
  // The next start sends what waited first (same batch ids; the server drops repeats).
  await page.reload();
  await collectorRunning(page);
  const links = () => psql(`select coalesce(string_agg(distinct props->>'to', ',' order by props->>'to'), '') from public.lp_tel_events where device = '${device}' and name = 'link' and props->>'what' = 'link'`);
  await expect.poll(links, { timeout: 45_000 }).toBe('offline,online');
});

test('the kill switch: the next send gets a 204, the collector stops (fetch restored, probe in 30 min) and never sends again', async ({ page }) => {
  test.setTimeout(150_000);
  psql(`update public.lp_tel_settings set enabled = false, updated_at = now()`);
  const statuses: number[] = [];
  page.on('response', (res) => {
    if (new URL(res.url()).pathname === '/api/telemetry') statuses.push(res.status());
  });
  await page.goto('/');
  await collectorRunning(page);
  await expect.poll(() => statuses, { timeout: 40_000 }).toContain(204);
  await page.waitForFunction(() => /\[native code\]/.test(String(window.fetch)), null, { timeout: 10_000 });
  const off = Number(await page.evaluate(() => window.localStorage.getItem('lp-tel-off')));
  expect(off - Date.now()).toBeGreaterThan(25 * 60_000);
  const after = statuses.length;
  // Activity for more than a send interval: taps, views, a hide; nothing goes out.
  for (let i = 0; i < 7; i += 1) {
    await page.evaluate((q) => window.history.pushState({}, '', q), i % 2 ? '/?view=pending' : '/');
    await page.mouse.click(200, 300);
    await page.waitForTimeout(10_000);
  }
  await flush(page);
  await page.waitForTimeout(1_000);
  expect(statuses.length).toBe(after);
});

test('with the telemetry route failing (500s, then timeouts) the app works exactly as before', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let hits = 0;
  await page.route('**/api/telemetry', async (route) => {
    hits += 1;
    if (hits % 2) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"unavailable","message":"x"}}' });
      return;
    }
    // A timeout: never answered within the client's 8 s.
    await new Promise((r) => setTimeout(r, 9_000));
    await route.fulfill({ status: 503, body: '' }).catch(() => undefined);
  });
  const r = await createPiiRequest(page);
  await page.goto(`/?r=${r.id}`);
  await expect(page.getByTestId('profile').first()).toBeVisible({ timeout: 15_000 });
  await collectorRunning(page);
  // A message goes out and is delivered as usual.
  await page.getByTestId('composer-input').fill(`${TAG} hello`);
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('thread').first()).toContainText(`${TAG} hello`, { timeout: 15_000 });
  await expect(page.getByTestId('receipt-failed')).toHaveCount(0);
  // Views change, the list loads, the request's own requests succeed.
  await page.evaluate(() => window.history.pushState({}, '', '/?view=pending'));
  await expect(page.locator(`[data-request-id="${r.id}"]`).first()).toBeAttached({ timeout: 15_000 });
  const detail = await call<RequestDetail>(page.request, 'GET', `/api/requests/${r.id}`);
  expect(detail.id).toBe(r.id);
  await flush(page);
  await expect.poll(() => hits, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('the first load carries no collector code', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-iphone14', 'request-based; one project is enough');
  const cookie = await sessionCookieHeader(STAFF);
  const html = await (await request.get('/', { headers: { cookie } })).text();
  const srcs = [...new Set([...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => (m[1] as string).replace(/&amp;/g, '&')))];
  expect(srcs.length).toBeGreaterThan(3);
  for (const src of srcs) {
    const body = await (await request.get(src)).text();
    expect(body.includes('lp-tel-'), src).toBe(false);
    expect(body.includes('stuck_scroll'), src).toBe(false);
  }
});
