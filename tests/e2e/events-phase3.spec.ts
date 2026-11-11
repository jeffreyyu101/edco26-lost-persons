import { execFileSync } from 'node:child_process';
import './helpers/api-event';
import { randomInt, randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { EventAdmin, RequestSummary } from '@/lib/api-types';
import { loadTestEnv, localDbUrl } from '../../scripts/test-env.mjs';
import { BASE, apiCreate, endAll, makeEvent, signInContext, type TestEvent } from './helpers/events';

// (Events, phase 3) The joined build end to end:
//   * two events live at once, different posts, teams and time zones, staff in each and a lead moving between them:
//     no request, list row, stat, alert or push target, message or LP number crosses over; both start at LP-0001;
//   * go live from the lead's screen: a second staff browser already open on the practice log loses the practice rows
//     within one sync;
//   * a lead switching events (desk switcher, phone Events list) never sees the previous event's cached rows, even
//     while GET /api/session is slow;
//   * one browser profile through the sign-in screen, event A then event B: no row of A is ever drawn in B.
// Every event is ended in afterAll. Synthetic names only. Runs in both browsers.

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

const RUN = Date.now().toString(36);
let seq = 0;
const uniq = (label: string) => `TEST-P3-${RUN}-${(seq += 1)} ${label}`;
const ENV: Record<string, string | undefined> = loadTestEnv();
const DESK = { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false };

test.afterAll(async () => {
  await endAll();
});

const psql = (sql: string) => execFileSync('psql', [localDbUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-c', sql], { encoding: 'utf8' }).trim();
const rowNamed = (page: Page, name: string) => page.locator('[data-request-id]', { hasText: name });
const fakeIp = () => `100.${64 + randomInt(64)}.${randomInt(256)}.${1 + randomInt(254)}`;

async function openApp(page: Page, path = '/') {
  await page.goto(path);
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
}

/** Every request row name the page ever draws, on every load of it (window.__drawn, kept in sessionStorage). */
async function recordDrawnRows(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = new Set<string>(JSON.parse(sessionStorage.getItem('p3-drawn') ?? '[]') as string[]);
    const note = () => {
      let grew = false;
      for (const el of document.querySelectorAll('[data-request-id]')) {
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text && !seen.has(text)) {
          seen.add(text);
          grew = true;
        }
      }
      if (grew) sessionStorage.setItem('p3-drawn', JSON.stringify([...seen]));
    };
    new MutationObserver(note).observe(document, { childList: true, subtree: true, characterData: true });
  });
}
const drawn = async (page: Page): Promise<string> => ((await page.evaluate(() => JSON.parse(sessionStorage.getItem('p3-drawn') ?? '[]') as string[])) ?? []).join('\n');
const resetDrawn = (page: Page) => page.evaluate(() => sessionStorage.removeItem('p3-drawn'));

/** A staff phone (or desk) signed in to the event, bell on (new requests alert), the app open. */
async function staffPage(browser: Browser, event: TestEvent, team: string, opts: { bell?: boolean; desk?: boolean } = {}): Promise<{ ctx: BrowserContext; page: Page; name: string }> {
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...(opts.desk ? DESK : {}) });
  const name = uniq(`${team} staff`);
  await signInContext(ctx, event.password, name, team);
  if (opts.bell) {
    const res = await ctx.request.post(`${BASE}/api/push/prefs`, { headers: { origin: BASE }, data: { newRequests: true } });
    expect(res.ok(), await res.text()).toBe(true);
    await ctx.addInitScript(() => {
      localStorage.setItem('lp-bell', '1');
      localStorage.setItem('lp-bell-intro-seen', '1');
    });
  }
  const page = await ctx.newPage();
  await recordDrawnRows(page);
  await openApp(page);
  return { ctx, page, name };
}

/** A lead browser (the lead passcode, no event open). */
async function leadContext(browser: Browser, desk = false): Promise<BrowserContext> {
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...(desk ? DESK : {}) });
  const ip = fakeIp();
  const res = await ctx.request.post(`${BASE}/api/session`, {
    headers: { origin: BASE, 'x-real-ip': ip, 'x-vercel-forwarded-for': ip },
    data: { staffName: uniq('Lead'), team: 'Other', otherTeam: 'Ground Control', password: ENV['LP_LEAD_PASSCODE'] },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ctx;
}

/** Opens `event` from the Events list (as a lead does on a phone), then the log. */
async function openFromEventsList(page: Page, event: TestEvent) {
  await page.goto('/events');
  await page.locator(`[data-testid="event-row"][data-slug="${event.slug}"] button`).click();
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
}

/** The event time of `iso` as a row shows it ("9:14" of "9:14 PM"). */
const clock = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).replace(/\s?[AP]M$/, '');

test('two events live at once: no request, row, stat, alert, push target, message or LP number crosses over; both start at LP-0001', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await makeEvent({
    name: uniq('Alpha'),
    timezone: 'America/New_York',
    posts: [{ id: 'north', label: 'Alpha North', short: 'North' }, { id: 'south', label: 'Alpha South', short: 'South' }],
    teams: [{ id: 'rovers', label: 'Alpha Rovers', short: 'Rovers' }, { id: 'medics', label: 'Alpha Medics', short: 'Medics', medical: true }],
  });
  const b = await makeEvent({
    name: uniq('Bravo'),
    timezone: 'Asia/Tokyo',
    dayStartHour: 9,
    posts: [{ id: 'pier', label: 'Bravo Pier', short: 'Pier' }, { id: 'dock', label: 'Bravo Dock', short: 'Dock' }, { id: 'hill', label: 'Bravo Hill', short: 'Hill' }],
    teams: [{ id: 'crew', label: 'Bravo Crew', short: 'Crew' }, { id: 'aid', label: 'Bravo Aid', short: 'Aid', medical: true }],
  });
  const rA = await staffPage(browser, a, 'Alpha Rovers');
  const mA = await staffPage(browser, a, 'Alpha Medics', { bell: true });
  const rB = await staffPage(browser, b, 'Bravo Crew');
  const mB = await staffPage(browser, b, 'Bravo Aid', { bell: true });

  // Both logs start at LP-0001.
  const reqA = await apiCreate(rA.ctx.request, { name: uniq('Alpha missing'), reportingLocation: 'Alpha North' });
  const reqB = await apiCreate(rB.ctx.request, { name: uniq('Bravo missing'), reportingLocation: 'Bravo Pier' });
  expect([reqA.caseNumber, reqB.caseNumber]).toEqual([1, 1]);

  // Each event's rows, in its own time zone, on its own staff's screens only.
  for (const s of [rA, mA]) await expect(rowNamed(s.page, reqA.name)).toContainText(clock(reqA.createdAt, 'America/New_York'), { timeout: 20_000 });
  for (const s of [rB, mB]) await expect(rowNamed(s.page, reqB.name)).toContainText(clock(reqB.createdAt, 'Asia/Tokyo'), { timeout: 20_000 });

  // The bell: each medical team hears about its own event's new request only.
  await expect(mA.page.getByText('New request · LP-0001')).toBeVisible({ timeout: 20_000 });
  await expect(mB.page.getByText('New request · LP-0001')).toBeVisible({ timeout: 20_000 });

  // A message on A's request: A's staff can read it; B's cannot reach the request at all.
  const msg = uniq('Alpha message');
  const posted = await rA.ctx.request.post(`${BASE}/api/requests/${reqA.id}/messages`, { headers: { origin: BASE }, data: { body: msg, clientMutationId: randomUUID() } });
  expect(posted.status(), await posted.text()).toBe(201);
  expect((await mA.ctx.request.get(`${BASE}/api/requests/${reqA.id}/messages`)).ok()).toBe(true);
  for (const s of [rB, mB]) {
    expect((await s.ctx.request.get(`${BASE}/api/requests/${reqA.id}`)).status()).toBe(404);
    expect((await s.ctx.request.get(`${BASE}/api/requests/${reqA.id}/messages`)).status()).toBe(404);
  }

  // A second request in A only: A is at LP-0002, B's next is still LP-0002 of its own.
  const reqA2 = await apiCreate(mA.ctx.request, { name: uniq('Alpha second'), reportingLocation: 'Alpha South' });
  expect(reqA2.caseNumber).toBe(2);
  await expect(rowNamed(rA.page, reqA2.name)).toBeVisible({ timeout: 20_000 });

  // Stats: each event counts its own requests and its own posts.
  const stats = async (s: { ctx: BrowserContext }) => (await (await s.ctx.request.get(`${BASE}/api/stats?range=today`)).json()) as Record<string, unknown>;
  const [sa, sb] = [JSON.stringify(await stats(rA)), JSON.stringify(await stats(rB))];
  expect(sa).toMatch(/Alpha North|"post":"North"/);
  expect(sa).not.toMatch(/Bravo/);
  expect(sb).toMatch(/Bravo Pier|"post":"Pier"/);
  expect(sb).not.toMatch(/Alpha/);
  await openApp(rA.page, '/?dashboard=1');
  await openApp(rB.page, '/?dashboard=1');
  await expect(rA.page.getByTestId('open-count')).toHaveText('2', { timeout: 20_000 });
  await expect(rB.page.getByTestId('open-count')).toHaveText('1', { timeout: 20_000 });

  // Push targets (who a new request would reach): staff with the switch on who have been active in that event. B's medic
  // answers on B's request first (a message), as A's medic logged A's second request.
  const msgB = uniq('Bravo message');
  const postedB = await mB.ctx.request.post(`${BASE}/api/requests/${reqB.id}/messages`, { headers: { origin: BASE }, data: { body: msgB, clientMutationId: randomUUID() } });
  expect(postedB.status(), await postedB.text()).toBe(201);
  const targets = (e: TestEvent) => psql(`select coalesce(array_to_string(public.lp_push_new_request_staff('${e.id}'), '|'), '')`).toLowerCase();
  expect(targets(a)).toContain(mA.name.toLowerCase());
  expect(targets(a)).not.toContain(mB.name.toLowerCase());
  expect(targets(b)).toContain(mB.name.toLowerCase());
  expect(targets(b)).not.toContain(mA.name.toLowerCase());

  // The lead moves between them on the desk: each event's rows and numbers only.
  const lead = await leadContext(browser, true);
  const page = await lead.newPage();
  await recordDrawnRows(page);
  await openFromEventsList(page, a);
  await expect(rowNamed(page, reqA2.name)).toBeVisible({ timeout: 20_000 });
  const leadB = await (async () => {
    await page.getByTestId('event-switcher').click();
    await page.getByTestId('event-switcher-menu').locator(`[data-slug="${b.slug}"]`).click();
    await expect(page.getByTestId('event-switcher')).toContainText(b.name, { timeout: 20_000 });
    await expect(rowNamed(page, reqB.name)).toBeVisible({ timeout: 20_000 });
    // The lead logs a request in B: B's LP-0002.
    return apiCreate(page.request, { name: uniq('Bravo by lead'), reportingLocation: 'Bravo Dock' });
  })();
  expect(leadB.caseNumber).toBe(2);
  await expect(rowNamed(page, leadB.name)).toBeVisible({ timeout: 20_000 });

  // Nothing of one event was ever drawn on the other's screens.
  for (const s of [rA, mA]) {
    const seen = await drawn(s.page);
    for (const n of [reqB.name, leadB.name, msgB]) expect(seen).not.toContain(n);
    await expect(s.page.getByText(reqB.name)).toHaveCount(0);
    await expect(s.page.getByText(msgB)).toHaveCount(0);
  }
  for (const s of [rB, mB]) {
    const seen = await drawn(s.page);
    for (const n of [reqA.name, reqA2.name, msg]) expect(seen).not.toContain(n);
    await expect(s.page.getByText(msg)).toHaveCount(0);
  }
  // And B's staff never got an alert for A's second request (LP-0002 is A's; B's LP-0002 is the lead's).
  await expect(mB.page.getByText(reqA2.name)).toHaveCount(0);

  await Promise.all([rA.ctx, mA.ctx, rB.ctx, mB.ctx, lead].map((c) => c.close()));
});

test('go live from the lead screen: a second staff browser already open on the practice log loses the practice rows within one sync', async ({ browser }) => {
  test.setTimeout(150_000);
  const event = await makeEvent({ name: uniq('Goes live'), practice: true, posts: [{ id: 'main', label: 'Main Post', short: 'Main' }], teams: [{ id: 'crew', label: 'Gate Crew', short: 'Crew' }] });
  const one = await staffPage(browser, event, 'Gate Crew');
  const two = await staffPage(browser, event, 'Gate Crew');
  const practice = [
    await apiCreate(one.ctx.request, { name: uniq('Practice one'), reportingLocation: 'Main Post' }),
    await apiCreate(one.ctx.request, { name: uniq('Practice two'), reportingLocation: 'Main Post' }),
  ];
  for (const s of [one, two]) {
    for (const r of practice) await expect(rowNamed(s.page, r.name)).toBeVisible({ timeout: 20_000 });
    await expect(s.page.getByRole('img', { name: 'Practice event' }).first()).toBeVisible();
  }
  // The second browser's syncs from here on.
  const syncs: number[] = [];
  two.page.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/sync') syncs.push(Date.now());
  });

  // The lead goes live from Event setup.
  const lead = await leadContext(browser);
  const page = await lead.newPage();
  await page.goto(`/events/${event.id}`);
  await page.getByTestId('stage-go-live').click();
  const sheet = page.getByRole('dialog', { name: 'Go live' });
  await expect(sheet.getByTestId('sheet-practice-count')).toHaveText('2');
  await sheet.getByTestId('stage-confirm').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('event-setup').getByTestId('event-stage')).toHaveText('Live');
  const liveAt = Date.now();
  syncs.length = 0;

  // Gone from the open browser within one sync interval (6 s, plus jitter and the config re-read).
  for (const r of practice) await expect(rowNamed(two.page, r.name)).toHaveCount(0, { timeout: 12_000 });
  const goneAt = Date.now();
  await expect(two.page.getByRole('img', { name: 'Live event' }).first()).toBeVisible();
  // At most one scheduled sync noticed it; anything after was the immediate re-read and refetch.
  const scheduled = syncs.filter((t) => t < goneAt);
  expect(scheduled.length, `syncs before the rows left: ${scheduled.map((t) => t - liveAt).join(', ')} ms`).toBeLessThanOrEqual(3);
  expect(goneAt - liveAt).toBeLessThan(12_000);
  for (const r of practice) await expect(rowNamed(one.page, r.name)).toHaveCount(0, { timeout: 12_000 });

  // A reload keeps them gone; the live log starts at LP-0001.
  await openApp(two.page);
  const live = await apiCreate(two.ctx.request, { name: uniq('Live one'), reportingLocation: 'Main Post' });
  expect(live.caseNumber).toBe(1);
  await expect(rowNamed(two.page, live.name)).toBeVisible({ timeout: 20_000 });
  for (const r of practice) await expect(rowNamed(two.page, r.name)).toHaveCount(0);
  expect(await drawn(two.page)).toContain(live.name);

  await Promise.all([one.ctx.close(), two.ctx.close(), lead.close()]);
});

for (const how of ['desk switcher', 'phone Events list'] as const) {
  test(`a lead switching events (${how}) never sees the previous event's cached rows, even with GET /api/session slow`, async ({ browser }) => {
    test.setTimeout(150_000);
    const teams = [{ id: 'crew', label: 'Gate Crew', short: 'Crew' }];
    const a = await makeEvent({ name: uniq('Switch A'), posts: [{ id: 'a', label: 'A Post', short: 'A' }], teams });
    const b = await makeEvent({ name: uniq('Switch B'), posts: [{ id: 'b', label: 'B Post', short: 'B' }], teams });
    const staffA = await browser.newContext({ serviceWorkers: 'block' });
    const staffB = await browser.newContext({ serviceWorkers: 'block' });
    await signInContext(staffA, a.password, uniq('A staff'), 'Gate Crew');
    await signInContext(staffB, b.password, uniq('B staff'), 'Gate Crew');
    const rowsA = [await apiCreate(staffA.request, { name: uniq('Only in A'), reportingLocation: 'A Post' })];
    const rowsB = [await apiCreate(staffB.request, { name: uniq('Only in B'), reportingLocation: 'B Post' })];

    const lead = await leadContext(browser, how === 'desk switcher');
    const page = await lead.newPage();
    await recordDrawnRows(page);
    // A first: its rows are now cached on this device.
    await openFromEventsList(page, a);
    await expect(rowNamed(page, rowsA[0]!.name)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1_500); // the cache write is queued behind the first sync
    // From here, the session check answers late: the app must not fill the gap with the last event's cache.
    await page.route('**/api/session', async (route) => {
      if (route.request().method() === 'GET') await new Promise((resolve) => setTimeout(resolve, 2_500));
      await route.continue();
    });

    const open = async (to: TestEvent) => {
      await resetDrawn(page);
      if (how === 'desk switcher') {
        await page.getByTestId('event-switcher').click();
        await page.getByTestId('event-switcher-menu').locator(`[data-slug="${to.slug}"]`).click();
        await expect(page.getByTestId('event-switcher')).toContainText(to.name, { timeout: 20_000 });
      } else {
        await openFromEventsList(page, to);
      }
    };

    await open(b);
    await expect(rowNamed(page, rowsB[0]!.name)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1_500);
    expect(await drawn(page)).not.toContain(rowsA[0]!.name);
    await expect(rowNamed(page, rowsA[0]!.name)).toHaveCount(0);

    // And back to A: its own rows, nothing of B.
    await open(a);
    await expect(rowNamed(page, rowsA[0]!.name)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1_500);
    expect(await drawn(page)).not.toContain(rowsB[0]!.name);

    await Promise.all([staffA.close(), staffB.close(), lead.close()]);
  });
}

test('one browser profile through the sign-in screen, event A then event B: no row of A is ever drawn in B', async ({ browser }) => {
  test.setTimeout(150_000);
  const teams = [{ id: 'crew', label: 'Gate Crew', short: 'Crew' }];
  const a = await makeEvent({ name: uniq('Profile A'), posts: [{ id: 'a', label: 'A Post', short: 'A' }], teams });
  const b = await makeEvent({ name: uniq('Profile B'), posts: [{ id: 'b', label: 'B Post', short: 'B' }], teams });
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const ip = fakeIp();
  await ctx.setExtraHTTPHeaders({ 'x-real-ip': ip, 'x-vercel-forwarded-for': ip });
  const page = await ctx.newPage();
  await recordDrawnRows(page);
  const staff = uniq('Same phone');

  const signIn = async (password: string) => {
    await page.goto('/signin');
    await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
    // Step 1, unless this phone remembers who signed in last (then it opens on the password).
    const name = page.getByRole('textbox', { name: 'Your name' });
    const pw = page.getByLabel('Event password');
    await expect(name.or(pw)).toBeVisible();
    if (!(await pw.isVisible())) {
      await name.fill(staff);
      await page.getByRole('textbox', { name: 'Other team' }).fill('Gate Crew');
      await page.getByRole('button', { name: 'Continue' }).click();
    }
    await pw.fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(`${BASE}/`);
    await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  };

  await signIn(a.password);
  const inA = await apiCreate(ctx.request, { name: uniq('Logged in A'), reportingLocation: 'A Post' });
  await expect(rowNamed(page, inA.name)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1_500);

  // Sign out from the account menu, then into B on the same phone.
  await page.getByTestId('account-trigger').click();
  await page.getByText('Sign out', { exact: true }).click();
  await expect(page).toHaveURL(/\/signin/, { timeout: 20_000 });
  await resetDrawn(page);
  const inB = await (async () => {
    await signIn(b.password);
    return apiCreate(ctx.request, { name: uniq('Logged in B'), reportingLocation: 'B Post' });
  })();
  expect(inB.caseNumber).toBe(1);
  await expect(rowNamed(page, inB.name)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1_500);
  expect(await drawn(page)).not.toContain(inA.name);
  // The server agrees: B's session sees B's rows only.
  const rows = ((await (await ctx.request.get(`${BASE}/api/sync`)).json()) as { rows: RequestSummary[] }).rows.map((r) => r.name);
  expect(rows).toEqual([inB.name]);
  // The event the phone works is B now (its config came with the session).
  const session = (await (await ctx.request.get(`${BASE}/api/session`)).json()) as { event: EventAdmin | null };
  expect(session.event?.name).toBe(b.name);
  await ctx.close();
});
