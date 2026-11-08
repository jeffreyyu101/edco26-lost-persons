import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { RequestDetail, RequestSummary, ThreadPage } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { newSignedInContext, signedInAs } from './helpers/session';

// The message lane (design/screens/msg-indicator.html, Brian 2026-11-07, with his override: the blue bubble is for
// everyone, it means "unread to you"), end to end on the real store, API and database, Chromium and WebKit:
//   phone (iPhone 14, 390 px)  the # column is gone; a fixed lane leads every row: the blue bubble with the unread
//                              count, the grey outline once read, nothing without messages; the names never move; a
//                              tap in the lane (a 52 px wide, full-height area) opens the request at its Messages, a
//                              tap on the name at its top; the row's sentence ends with the lane's words
//   desk (1440 × 900)          the same lane leads the table before #; no count pill after the name; a click in the
//                              lane lands at the thread; docked, # goes; the nav's Pending carries the filled bubble
// Synthetic rows only (TEST-ML-…), closed again afterwards.

const BASE = testBaseUrl();
const FOH = { staffName: 'TEST-ML Dana Front', team: 'GC/HX - Dispatch' };
const MED = { staffName: 'TEST-ML Rae Medic', team: 'Medical' };
const TAG = `TEST-ML-${Date.now().toString(36)}`;
const SYNC = { timeout: 20_000 };
let seq = 0;

test.use({ bypassCSP: true, serviceWorkers: 'block' });
signedInAs(FOH);

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function call<T>(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/** A request with every section filled, so the thread sits well below the first screen. */
async function createRequest(request: APIRequestContext): Promise<RequestSummary> {
  seq += 1;
  const { request: row } = await call<{ request: RequestSummary }>(request, 'POST', '/api/requests', {
    clientMutationId: randomUUID(),
    reportingLocation: 'FA 3 – Kinetic',
    name: `${TAG} P${seq}`,
    age: 'mid-20s',
    gender: 'Female',
    clothing: `Synthetic ${TAG} silver jacket ${seq}`,
    lastSeen: 'kineticFIELD rail',
    hair: 'Long, blue braids',
    contactName: `${TAG} Friend ${seq}`,
    contactRelationship: 'Friend',
    contactPhone: '(407) 555-0142',
  });
  created.push({ id: row.id, request });
  return row;
}

/** A message from `request`'s staff member. Waits out the 20-a-minute limit (a re-run within the minute) and retries. */
async function say(request: APIRequestContext, id: string, body: string): Promise<void> {
  const data = { clientMutationId: randomUUID(), body };
  for (let attempt = 0; ; attempt++) {
    const res = await request.fetch(`/api/requests/${id}/messages`, { method: 'POST', data, headers: { Origin: BASE } });
    if (res.status() === 429 && attempt < 3) {
      const wait = ((await res.json()) as { error?: { retryAfterSeconds?: number } }).error?.retryAfterSeconds ?? 10;
      await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
      continue;
    }
    expect(res.ok(), `POST /api/requests/${id}/messages → ${res.status()} ${await res.text()}`).toBe(true);
    return;
  }
}

async function withMedical<T>(browser: Browser, run: (med: APIRequestContext) => Promise<T>): Promise<T> {
  const ctx: BrowserContext = await newSignedInContext(browser, MED, { baseURL: BASE });
  try {
    return await run(ctx.request);
  } finally {
    await ctx.close();
  }
}

test.afterEach(async () => {
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await call<RequestDetail>(request, 'GET', `/api/requests/${id}`);
      if (row.status === 'Added') await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: BASE } });
    } catch {
      // Best effort.
    }
  }
});

/**
 * Three requests logged by front of house: `unread` with 2 messages from medical (unread for me), `read` with one
 * medical message I have read, `none` with no messages.
 */
async function seed(page: Page, browser: Browser) {
  const unread = await createRequest(page.request);
  const read = await createRequest(page.request);
  const none = await createRequest(page.request);
  await withMedical(browser, async (med) => {
    await say(med, unread.id, 'Any tattoos or marks?');
    await say(med, unread.id, 'Checking the tents at FA 3 now');
    await say(med, read.id, 'Friend can come to FA 3');
  });
  const thread = await call<ThreadPage>(page.request, 'GET', `/api/requests/${read.id}/messages`);
  await call(page.request, 'POST', `/api/requests/${read.id}/messages/read`, { upto: thread.messages[thread.messages.length - 1]!.createdAt });
  expect((await call<ThreadPage>(page.request, 'GET', `/api/requests/${unread.id}/messages`)).activity.unread).toBe(2);
  expect((await call<ThreadPage>(page.request, 'GET', `/api/requests/${read.id}/messages`)).activity.unread).toBe(0);
  return { unread, read, none };
}

const profile = (page: Page) => page.getByTestId('profile');
const title = (page: Page) => profile(page).locator('h1');
const threadHead = (page: Page) => page.getByTestId('messages').getByRole('heading', { name: 'Messages', exact: true });

/** The request open at its Messages: the heading on screen, the request's name scrolled past. */
async function expectAtThread(page: Page): Promise<void> {
  await expect(threadHead(page)).toBeInViewport(SYNC);
  await expect(title(page)).not.toBeInViewport();
}

/** The request open at its top: its name on screen, nothing scrolled. */
async function expectAtTop(page: Page): Promise<void> {
  await expect(title(page)).toBeInViewport(SYNC);
  await page.waitForTimeout(600);
  await expect(title(page)).toBeInViewport();
  const scrolled = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="desk-pane"] [data-testid="profile"]');
    return pane?.parentElement ? pane.parentElement.scrollTop : window.scrollY;
  });
  expect(scrolled).toBe(0);
}

const lane = (row: Locator) => row.locator('[data-lane]');

/** The lane's mark as the eye reads it: 'unread 2', 'read', or '' (nothing). */
function markOf(row: Locator): Promise<string> {
  return lane(row).evaluate((el) => {
    const mark = el.getAttribute('data-mark');
    if (mark === 'unread') return `unread ${el.textContent ?? ''}`;
    if (mark === 'read') return el.querySelector('svg.lucide-message-square') ? 'read' : 'read without its icon';
    return el.textContent || el.children.length ? 'something' : '';
  });
}

/** Hit-testing the row at a point (relative to the row's box): does a tap there land in the lane? */
function landsInLane(row: Locator, x: number, y: number): Promise<boolean> {
  return row.evaluate(
    (el, [px, py]) => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + (px < 0 ? box.width + px : px), box.top + (py < 0 ? box.height + py : py));
      return !!hit && el.contains(hit) && !!hit.closest('[data-thread-badge]');
    },
    [x, y] as const,
  );
}

test.describe('phone 390 × 844', () => {
  test('the lane: blue bubble with the unread count, grey outline once read, nothing without; names line up', async ({ page, browser }) => {
    test.slow();
    const { unread, read, none } = await seed(page, browser);
    await page.goto('/');
    const row = (r: RequestSummary) => page.locator(`[data-testid="request-list"] [data-request-id="${r.id}"]`);
    await expect(row(unread)).toBeVisible(SYNC);
    await expect.poll(() => markOf(row(unread)), SYNC).toBe('unread 2');
    await expect.poll(() => markOf(row(read)), SYNC).toBe('read');
    expect(await markOf(row(none))).toBe('');

    // No # column and nothing over the lane.
    await expect(page.getByTestId('log-columns')).toHaveText(/^Friend\s*Status\s*Created\s*Updated$/);
    await expect(page.locator('[data-testid="request-list"] [data-col="number"]')).toHaveCount(0);

    // The names never move: every name starts 52 px in (16 px gutter, 31 px lane, 5 px gap).
    for (const r of [unread, read, none]) {
      const rowBox = (await row(r).boundingBox())!;
      const nameBox = (await row(r).locator('[data-col="name"]').boundingBox())!;
      expect(nameBox.x - rowBox.x, r.name).toBeCloseTo(52, 0);
    }
    // The bubble: badge blue with white bold tabular numerals, inside the 31 px lane.
    const bubble = lane(row(unread)).locator('span').first();
    const look = await bubble.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, color: cs.color, weight: cs.fontWeight, size: cs.fontSize, width: el.getBoundingClientRect().width };
    });
    expect(look.color).toBe('rgb(255, 255, 255)');
    expect(look.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(look.weight).toBe('700');
    expect(look.size).toBe('12px');
    expect(look.width).toBeLessThanOrEqual(31);
    // The read outline: 18 px, gray-11.
    const outline = lane(row(read)).locator('svg');
    expect((await outline.boundingBox())!.width).toBeCloseTo(18, 0);

    // Screen readers: the visible mark is hidden; the row's sentence keeps its LP number and ends with the lane's words.
    await expect(lane(row(unread))).toHaveAttribute('aria-hidden', 'true');
    // (Medical's question makes it Needs info: amber in Status, while the lane stays blue.)
    await expect(row(unread)).toHaveAccessibleName(new RegExp(`^LP-\\d{4}, ${unread.name}, (Needs info|Waiting for check), created [^,]+, (not updated yet|updated [^.]+)\\. 2 unread messages\\.$`));
    await expect(row(read)).toHaveAccessibleName(new RegExp(`^LP-\\d{4}, ${read.name}, .+\\. 1 message\\.$`));
    await expect(row(none)).toHaveAccessibleName(new RegExp(`^LP-\\d{4}, ${none.name}, Waiting for check, created [^,]+, not updated yet$`));

    // The tap area: the row's left 52 px over its full height (at least 44 × 44), only where there is a mark.
    await row(unread).scrollIntoViewIfNeeded();
    const rowBox = (await row(unread).boundingBox())!;
    expect(rowBox.height).toBeGreaterThanOrEqual(44);
    const area = await lane(row(unread)).evaluate((el) => {
      const cs = getComputedStyle(el, '::before');
      return { position: cs.position, width: parseFloat(cs.width), height: parseFloat(cs.height) };
    });
    expect(area.position).toBe('absolute');
    expect(area.width).toBeGreaterThanOrEqual(44);
    expect(area.height).toBeGreaterThanOrEqual(44);
    for (const [x, y] of [[2, 2], [2, -2], [50, 2], [50, -2], [24, 24]] as const) expect(await landsInLane(row(unread), x, y), `${x},${y}`).toBe(true);
    expect(await landsInLane(row(unread), 56, 24)).toBe(false);
    expect(await landsInLane(row(none), 10, 24)).toBe(false);
    // The row is still one button.
    await expect(row(unread).locator('button, a, [role="button"]')).toHaveCount(0);
  });

  test('a tap in the lane opens the request at its Messages; a tap on the name at its top', async ({ page, browser }) => {
    test.slow();
    const { unread, read } = await seed(page, browser);
    await page.goto('/');
    const row = (r: RequestSummary) => page.locator(`[data-testid="request-list"] [data-request-id="${r.id}"]`);
    await expect.poll(() => markOf(row(unread)), SYNC).toBe('unread 2');

    // In the lane's padding, left of the bubble: still the lane.
    await row(unread).click({ position: { x: 6, y: 24 } });
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(unread.id);
    await expectAtThread(page);

    await page.goBack();
    await expect.poll(() => markOf(row(read)), SYNC).toBe('read');
    // The read outline lands at Messages too.
    await lane(row(read)).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(read.id);
    await expectAtThread(page);

    await page.goBack();
    await expect(row(unread)).toBeVisible(SYNC);
    await row(unread).locator('[data-col="name"]').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(unread.id);
    await expectAtTop(page);
  });
});

test.describe('desk 1440 × 900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('the lane leads the table before #; no pill after the name; a click in it lands at the thread; docked, # goes', async ({ page, browser }) => {
    test.slow();
    const { unread, read, none } = await seed(page, browser);
    await page.goto('/');
    const main = page.locator('[data-desk-main]');
    const row = (r: RequestSummary) => main.locator(`[data-request-id="${r.id}"]`);
    await expect.poll(() => markOf(row(unread)), SYNC).toBe('unread 2');
    await expect.poll(() => markOf(row(read)), SYNC).toBe('read');
    expect(await markOf(row(none))).toBe('');
    await expect(main.getByTestId('row-unread')).toHaveCount(0);

    // Before #: the lane (24 px in, 31 px wide), then the number (12 px gap), then the name, on every row.
    for (const r of [unread, read, none]) {
      const rowBox = (await row(r).boundingBox())!;
      const laneBox = (await lane(row(r)).boundingBox())!;
      const num = row(r).locator('[data-col="number"]');
      await expect(num).toHaveText(String(r.caseNumber));
      const numBox = (await num.boundingBox())!;
      expect(laneBox.x - rowBox.x).toBeCloseTo(24, 0);
      expect(laneBox.x + laneBox.width).toBeLessThanOrEqual(numBox.x);
      expect(numBox.x - rowBox.x).toBeCloseTo(24 + 31 + 12, 0);
    }
    // The column header: nothing over the lane, # first among the labels.
    await expect(main.getByTestId('desk-table-columns').locator('[data-col]').first()).toHaveText('#');
    await expect(row(unread)).toHaveAccessibleName(/, logged by TEST-ML Dana Front, Dispatch\. 2 unread messages\.$/);
    await expect(row(read)).toHaveAccessibleName(/\. 1 message\.$/);
    // The hit area: the row's left edge, the lane and half the gap, the row's full height.
    const area = await lane(row(unread)).evaluate((el) => {
      const cs = getComputedStyle(el, '::before');
      return { width: parseFloat(cs.width), height: parseFloat(cs.height) };
    });
    expect(area.width).toBeCloseTo(61, 0);
    expect(area.height).toBeGreaterThanOrEqual(44);
    // The nav's Pending: the filled bubble in the badge blue (a Pending request has unread messages).
    const navMark = page.getByTestId('desk-sidebar').getByTestId('unread-mark');
    await expect(navMark).toBeVisible(SYNC);
    await expect(navMark).toHaveAttribute('fill', 'currentColor');
    const [r, , b] = (await navMark.evaluate((el) => getComputedStyle(el).color)).match(/\d+/g)!.map(Number);
    expect(b! - r!, 'blue, not the nav grey').toBeGreaterThan(80);

    // A click on the name: the request docks beside the table at its top. Docked, # goes (the pane's top bar
    // carries the LP number); the lane stays.
    await row(read).locator('[data-col="friend"]').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(read.id);
    await expect(page.getByTestId('desk-pane')).toBeVisible();
    await expectAtTop(page);
    await expect(main.getByTestId('desk-table-columns').locator('[data-col="number"]')).toBeHidden();
    await expect(row(unread).locator('[data-col="number"]')).toBeHidden();
    await expect(lane(row(unread))).toBeVisible();
    const docked = await lane(row(unread)).evaluate((el) => parseFloat(getComputedStyle(el, '::before').width));
    expect(docked).toBeCloseTo(61, 0);

    // A click in the lane while another request is docked: the pane switches to that request at its Messages, the
    // composer focused (a computer). The desk opens rows in place while one is open (ShortcutManager), and the lane
    // keeps its meaning there.
    await lane(row(unread)).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(unread.id);
    await expectAtThread(page);
    await expect(page.getByTestId('messages').getByTestId('composer-input')).toBeFocused(SYNC);

    // The open request's own lane: back to its Messages after scrolling to the top.
    // (Re-scrolled until it holds: the jump's smooth scroll may still be settling.)
    await expect(async () => {
      await page.evaluate(() => document.querySelector('[data-testid="desk-pane"] [data-testid="profile"]')?.parentElement?.scrollTo(0, 0));
      await expect(title(page)).toBeInViewport({ timeout: 500 });
    }).toPass(SYNC);
    await page.getByTestId('messages').getByTestId('composer-input').blur();
    await lane(row(unread)).click();
    await expectAtThread(page);
    await expect(page.getByTestId('messages').getByTestId('composer-input')).toBeFocused(SYNC);

    // A search by the number: undocked, # highlights it (nothing under the name); docked, # is gone and the LP
    // number shows highlighted under the name instead.
    await page.goto(`/?q=${unread.caseNumber}`);
    const num = String(unread.caseNumber);
    await expect(row(unread).locator('[data-col="number"] mark')).toHaveText(num, SYNC);
    await expect(row(unread).locator('[data-col="friend"] mark')).toBeHidden();
    await row(unread).locator('[data-col="friend"]').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(unread.id);
    await expect(page.getByTestId('desk-pane')).toBeVisible();
    await expect(row(unread).locator('[data-col="number"]')).toBeHidden();
    await expect(row(unread).locator('[data-col="friend"] mark')).toBeVisible();
    await expect(row(unread).locator('[data-col="friend"] mark')).toHaveText(num);
    await expect(row(unread).locator('[data-col="friend"]')).toContainText(`LP-${num.padStart(4, '0')}`);

    // The nav's Pending as the current page, in light mode: still the badge blue, not the current item's grey.
    await page.goto('/?view=pending');
    await expect(page.locator('html')).toHaveClass(/\blight\b/);
    await expect(page.getByTestId('desk-sidebar').locator('[aria-current="page"]')).toContainText('Pending');
    await expect(navMark).toBeVisible(SYNC);
    const [pr, , pb] = (await navMark.evaluate((el) => getComputedStyle(el).color)).match(/\d+/g)!.map(Number);
    expect(pb! - pr!, 'blue on the current Pending, not its grey').toBeGreaterThan(80);
  });
});
