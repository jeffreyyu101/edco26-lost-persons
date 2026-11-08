import { randomUUID } from 'node:crypto';
import { devices, expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { RequestDetail, RequestSummary, ThreadPage } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { axeViolations, type AxeFinding } from './helpers/a11y';
import { OVERFLOW_WIDTHS, expectNoOverflow } from './helpers/overflow';
import { newSignedInContext, signedInAs } from './helpers/session';
import { realTouchSwipe } from './helpers/swipe';

// Request page order (Brian 2026-11-07, design/DECISIONS.md "Request page order", spec R1–R3), end to end on the
// real store, API and database, phone (iPhone 14) and desk (1440 × 900), Chromium and WebKit:
//   R1  header → status block → the latest-message line → Details → Photos → Messages → Audit trail; the line
//       shows for Needs info and for unread messages, and not otherwise (no messages, read, my reply latest)
//   R2  the Message button, a desk row's message lane, an Activity row whose latest event is a message, a
//       message's notification (in place and as a new page) and the line itself land at the thread; the phone
//       never focuses the composer (its keyboard stays down), the desk does; a row, a Pending card and an old
//       "/?r=<id>" open at the top
//       (a count only from the phone's cache, read meanwhile on another device, keeps no line, not even for a moment)
//   overflow at 375, 390, 820, 1180 and 1440 px in light and dark; axe on the request with the line.
//   (2026-11-08, request page tonight) the line has no Needs info chip of its own (T1), wraps to two lines with the
//   message's time at its right (T2); a phone's jump to a long thread keeps the message field above the sticky action
//   bar. (2026-11-08, full scroll fix) On a phone the thread is part of the page: a swipe that starts on it scrolls the
//   page down and up, "Earlier messages" keeps the message on screen in place, a new message shows the "New messages"
//   pill without moving the page while the reader is higher up and the page follows at the thread's end; the desk
//   pane's thread still scrolls in its own box.
// Synthetic rows only (TEST-RO-…), closed again afterwards.

const BASE = testBaseUrl();
const FOH = { staffName: 'TEST-RO Dana Front', team: 'GC/HX - Dispatch' };
const MED = { staffName: 'TEST-RO Rae Medic', team: 'Medical' };
const TAG = `TEST-RO-${Date.now().toString(36)}`;
const SYNC = { timeout: 20_000 };
/** The latest message's time on the line (T2): the clock today. */
const TIME = /^\d{1,2}:\d\d (AM|PM)$/;
const DESK = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 } as const;
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
    gender: 'Male',
    clothing: `Synthetic ${TAG} red hoodie ${seq}`,
    lastSeen: 'kineticFIELD rail',
    hair: 'Long, blue braids',
    contactName: `${TAG} Friend ${seq}`,
    contactRelationship: 'Friend',
    contactPhone: '(407) 555-0142',
  });
  created.push({ id: row.id, request });
  return row;
}

const say = (request: APIRequestContext, id: string, body: string) => call(request, 'POST', `/api/requests/${id}/messages`, { clientMutationId: randomUUID(), body });

async function inMedical(request: APIRequestContext, id: string): Promise<void> {
  const row = await call<RequestDetail>(request, 'GET', `/api/requests/${id}`);
  await call(request, 'POST', `/api/requests/${id}/status`, { status: 'Found – Awaiting Reunion', expectedVersion: row.rowVersion, kind: 'answer' });
}

test.afterEach(async () => {
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await call<RequestDetail>(request, 'GET', `/api/requests/${id}`);
      if (row.status === 'Added') await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: BASE } });
      else if (row.status === 'Found – Awaiting Reunion')
        await request.fetch(`/api/requests/${id}/status`, { method: 'POST', data: { status: 'Reunited – Closed', expectedVersion: row.rowVersion, kind: 'reunite' }, headers: { Origin: BASE } });
    } catch {
      // Best effort.
    }
  }
});

async function withMedical<T>(browser: Browser, run: (med: APIRequestContext) => Promise<T>): Promise<T> {
  const ctx: BrowserContext = await newSignedInContext(browser, MED, { baseURL: BASE });
  try {
    return await run(ctx.request);
  } finally {
    await ctx.close();
  }
}

const profile = (page: Page) => page.getByTestId('profile');
const title = (page: Page) => profile(page).locator('h1');
const line = (page: Page) => page.getByTestId('thread-preview');
const messages = (page: Page) => page.getByTestId('messages');
const threadHead = (page: Page) => messages(page).getByRole('heading', { name: 'Messages', exact: true });
const composer = (page: Page) => messages(page).getByTestId('composer-input');
const sectionHead = (page: Page, name: string) => profile(page).getByRole('heading', { name, exact: true });

/**
 * The request open at its Messages: the request's name scrolled past, the heading on screen in the top half of the
 * request's scroller, or as far up as the scroller goes (little below it).
 */
async function expectAtThread(page: Page): Promise<void> {
  await expect(threadHead(page)).toBeInViewport(SYNC);
  await expect(title(page)).not.toBeInViewport();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const head = document.querySelector('[data-testid="messages"] h2');
        const pane = document.querySelector('[data-testid="desk-pane"] [data-testid="profile"]')?.parentElement ?? null;
        if (!head) return 'no heading';
        const top = pane ? pane.getBoundingClientRect().top : 0;
        const height = pane ? pane.clientHeight : window.innerHeight;
        const atEnd = pane ? pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2 : window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
        return head.getBoundingClientRect().top - top < height / 2 || atEnd ? 'at thread' : `heading at ${Math.round(head.getBoundingClientRect().top - top)} of ${height}`;
      }),
    )
    .toBe('at thread');
}

/** The request open at its top: its name on screen, nothing scrolled (on a phone the thread is below the screen). */
async function expectAtTop(page: Page): Promise<void> {
  await expect(title(page)).toBeInViewport(SYNC);
  await page.waitForTimeout(600);
  await expect(title(page)).toBeInViewport();
  if (page.viewportSize()!.width < 768) await expect(threadHead(page)).not.toBeInViewport();
  expect(await scrollOf(page)).toBe(0);
}

/** How far the request is scrolled: the window on a phone, the pane's body on the desk. */
function scrollOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const pane = document.querySelector('[data-testid="desk-pane"] [data-testid="profile"]');
    return pane?.parentElement ? pane.parentElement.scrollTop : window.scrollY;
  });
}

/** The tops of the request's parts, in page order. */
async function order(page: Page, withLine: boolean): Promise<number[]> {
  const parts: Locator[] = [
    title(page),
    page.getByTestId('status-block'),
    ...(withLine ? [line(page)] : []),
    sectionHead(page, 'Missing person'),
    sectionHead(page, 'Friend or family'),
    sectionHead(page, 'Photos'),
    threadHead(page),
    sectionHead(page, 'Audit trail'),
  ];
  const tops: number[] = [];
  for (const p of parts) tops.push((await p.boundingBox())?.y ?? Number.NaN);
  return tops;
}

const ascending = (tops: number[]) => tops.every((t, i) => Number.isFinite(t) && (i === 0 || t > tops[i - 1]!));

async function unreadOnServer(request: APIRequestContext, id: string): Promise<number> {
  return (await call<ThreadPage>(request, 'GET', `/api/requests/${id}/messages`)).activity.unread;
}

/**
 * The request's unread count in the phone's row cache (IndexedDB `lp-client` / `kv`, `cache:<event>:<staff>:rows`),
 * or null. Never creates the database (an upgrade is aborted), so call it once the app has started.
 */
function cachedUnread(page: Page, id: string): Promise<number | null> {
  return page.evaluate(
    (rid) =>
      new Promise<number | null>((resolve) => {
        const open = indexedDB.open('lp-client');
        open.onupgradeneeded = () => open.transaction?.abort();
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const db = open.result;
          const done = (value: number | null) => {
            db.close();
            resolve(value);
          };
          if (!db.objectStoreNames.contains('kv')) return done(null);
          const os = db.transaction('kv', 'readonly').objectStore('kv');
          const keys = os.getAllKeys();
          keys.onerror = () => done(null);
          keys.onsuccess = () => {
            const key = keys.result.map(String).find((k) => k.startsWith('cache:') && k.endsWith(':rows'));
            if (!key) return done(null);
            const get = os.get(key);
            get.onerror = () => done(null);
            get.onsuccess = () => {
              const rows = get.result as Array<{ id?: string; unread?: number }> | undefined;
              const row = Array.isArray(rows) ? rows.find((x) => x.id === rid) : undefined;
              done(row ? (row.unread ?? 0) : null);
            };
          };
        };
      }),
    id,
  );
}

/** The app with the request in its list, and its row cache holding `unread` for it. */
async function cachedWithUnread(page: Page, id: string, unread: number): Promise<void> {
  await page.goto('/');
  await expect(page.locator(`[data-request-id="${id}"]`).first()).toBeVisible(SYNC);
  await expect.poll(() => cachedUnread(page, id), SYNC).toBe(unread);
}

/** What public/sw.js does on a notification click with an app window open: it asks the page to open the URL. */
function workerAsksToOpen(page: Page, url: string): Promise<unknown> {
  return page.evaluate(
    (u) =>
      new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (e) => resolve(e.data);
        setTimeout(() => resolve(null), 1_000);
        navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'lp-open', url: u }, ports: [channel.port2] }));
      }),
    url,
  );
}

/** The thread's own box: its overflow, and whether it has anything of its own to scroll. */
function threadBox(page: Page): Promise<{ overflowY: string; scrolls: boolean }> {
  return messages(page)
    .getByTestId('thread')
    .evaluate((el) => ({ overflowY: getComputedStyle(el).overflowY, scrolls: el.scrollHeight - el.clientHeight > 1 }));
}

/**
 * `count` messages that alternate between two staff of their own, medical and front of house (every one opens a run): a
 * tall thread. Their own, so the per-person limit of 20 messages a minute never trips across tests.
 */
async function longThread(browser: Browser, id: string, count: number, label = 'Synthetic handover note'): Promise<void> {
  const who = randomUUID().slice(0, 8);
  const med = await newSignedInContext(browser, { staffName: `TEST-RO Rae Medic ${who}`, team: 'Medical' }, { baseURL: BASE });
  const foh = await newSignedInContext(browser, { staffName: `TEST-RO Dana Front ${who}`, team: 'GC/HX - Dispatch' }, { baseURL: BASE });
  try {
    for (let i = 1; i <= count; i += 1) await say((i % 2 ? med : foh).request, id, `${label} ${i}`);
  } finally {
    await med.close();
    await foh.close();
  }
}

const pageY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));

/** Scrolls the page so the bubble's top sits `y` px from the top of the screen. */
async function bubbleAt(page: Page, bubble: Locator, y: number): Promise<void> {
  await bubble.evaluate((el, at) => window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - at, behavior: 'instant' }), y);
}

/**
 * A swipe that starts on the thread and moves the finger by `dy` (negative: up, the page scrolls down). Chromium: a real
 * touch through DevTools. WebKit has no touch or wheel input on a mobile page in Playwright, so there the page is a
 * phone-width WebKit page without the mobile flag, and the wheel goes over the same point (a wheel, like a finger,
 * scrolls the nearest box under it that can scroll).
 */
async function swipeOnThread(page: Page, touch: boolean, at: Locator, dy: number): Promise<void> {
  const box = (await at.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (touch) {
    await realTouchSwipe(page, x, y, dy, { ms: 300, steps: 10, hold: 60 });
  } else {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -dy);
  }
  await page.waitForTimeout(400);
}

/** What a finger on this point would scroll: the nearest box under it with room to scroll, or "page". */
function scrollsUnder(page: Page, at: Locator): Promise<string> {
  return at.evaluate((el) => {
    for (let box = el as Element | null; box && box !== document.body && box !== document.documentElement; box = box.parentElement) {
      const style = getComputedStyle(box);
      if (/(auto|scroll)/.test(style.overflowY) && box.scrollHeight - box.clientHeight > 1) return box.getAttribute('data-testid') ?? box.tagName;
    }
    return 'page';
  });
}

/** The message field ends above the sticky action bar, in view. */
async function expectFieldAboveBar(page: Page, label: string): Promise<void> {
  const field = (await composer(page).boundingBox())!;
  const bar = (await page.getByTestId('profile-actions').boundingBox())!;
  expect(field.y + field.height, `${label}: the field ends above the action bar`).toBeLessThanOrEqual(bar.y);
  await expect(composer(page)).toBeInViewport({ ratio: 1 });
}

test.describe('phone', () => {
  test('the order, and the line for Needs info until front of house answers', async ({ page, browser }) => {
    test.slow();
    const r = await createRequest(page.request);
    await withMedical(browser, (med) => say(med, r.id, 'Any tattoos or marks?'));

    await page.goto(`/?r=${r.id}`);
    await expect(line(page)).toBeVisible(SYNC);
    expect(ascending(await order(page, true)), (await order(page, true)).join(', ')).toBe(true);
    // (T1) No second Needs info chip on the line: the status block right above it says Needs info.
    await expect(line(page).getByTestId('stage-chip')).toHaveCount(0);
    await expect(page.getByTestId('status-block')).toContainText('Needs info');
    await expect(line(page)).toContainText('Any tattoos or marks?');
    await expect(line(page).getByTestId('preview-unread')).toBeVisible();
    // (T2) The message's time at the right, and in the sentence.
    await expect(line(page).getByTestId('preview-time')).toHaveText(TIME);
    await expect(line(page)).toHaveAccessibleName(/^Last message, unread, from .+ at \d{1,2}:\d\d (AM|PM): Any tattoos or marks\? Go to messages\.$/);
    // (2026-11-08) The thread is part of the page on the phone: no box of its own to scroll.
    expect(await threadBox(page)).toEqual({ overflowY: 'visible', scrolls: false });
    const box = (await line(page).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    // Right under the status block.
    const block = (await page.getByTestId('status-block').boundingBox())!;
    expect(box.y - (block.y + block.height)).toBeLessThan(24);

    // Front of house answers: Needs info ends, and the line goes.
    await say(page.request, r.id, 'Butterfly tattoo, left wrist');
    await expect(line(page)).toHaveCount(0, SYNC);
    expect(ascending(await order(page, false))).toBe(true);
  });

  test('Located with an unread message: the line with its dot; once read, and with no messages, no line', async ({ page, browser }) => {
    test.slow();
    const r = await createRequest(page.request);
    const plain = await createRequest(page.request);
    await withMedical(browser, async (med) => {
      await inMedical(med, r.id);
      await say(med, r.id, 'Bring 1 person only');
    });
    await expect.poll(() => unreadOnServer(page.request, r.id), SYNC).toBe(1);

    await page.goto(`/?r=${r.id}`);
    await expect(line(page)).toBeVisible(SYNC);
    await expect(line(page)).toContainText('Bring 1 person only');
    await expect(line(page).getByTestId('preview-unread')).toBeVisible();
    await expect(line(page).getByTestId('stage-chip')).toHaveCount(0);
    expect(ascending(await order(page, true))).toBe(true);
    // The thread read it as it loaded; the line stays for this visit.
    await expect.poll(() => unreadOnServer(page.request, r.id), SYNC).toBe(0);
    await page.waitForTimeout(1_000);
    await expect(line(page)).toBeVisible();

    // Opened again with everything read: no line.
    await page.goto(`/?r=${r.id}`);
    await expect(messages(page)).toBeVisible(SYNC);
    await expect(messages(page).getByTestId('bubble-them')).toHaveText('Bring 1 person only', SYNC);
    await expect(line(page)).toHaveCount(0);

    await page.goto(`/?r=${plain.id}`);
    await expect(messages(page).getByTestId('thread-empty')).toBeVisible(SYNC);
    await expect(line(page)).toHaveCount(0);
    expect(ascending(await order(page, false))).toBe(true);
  });

  test('a reload after the thread was read elsewhere: no line, not even for a moment; an unread message in the cache still shows it', async ({ page, browser }) => {
    test.slow();
    const r = await createRequest(page.request);
    await withMedical(browser, async (med) => {
      await inMedical(med, r.id);
      await say(med, r.id, 'Bring 1 person only');
    });
    await expect.poll(() => unreadOnServer(page.request, r.id), SYNC).toBe(1);

    // Unread in the cache and on the server: the line, with its dot, once this visit hears from the server.
    await cachedWithUnread(page, r.id, 1);
    await page.goto(`/?r=${r.id}`);
    await expect(line(page)).toBeVisible(SYNC);
    await expect(line(page).getByTestId('preview-unread')).toBeVisible();
    await expect.poll(() => unreadOnServer(page.request, r.id), SYNC).toBe(0);

    // A new message reaches the phone's cache; the phone leaves the app; the same staff reads it on another device.
    await withMedical(browser, (med) => say(med, r.id, 'Gate C, by the info tent'));
    await cachedWithUnread(page, r.id, 1);
    await page.goto('about:blank');
    const thread = await call<ThreadPage>(page.request, 'GET', `/api/requests/${r.id}/messages`);
    await call(page.request, 'POST', `/api/requests/${r.id}/messages/read`, { upto: thread.messages[thread.messages.length - 1]!.createdAt });
    expect(await unreadOnServer(page.request, r.id)).toBe(0);

    // Reopened with the cache still counting it unread: the line never shows.
    await page.addInitScript(() => {
      const w = window as unknown as { __lineSeen?: boolean };
      w.__lineSeen = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="thread-preview"]')) w.__lineSeen = true;
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`/?r=${r.id}`);
    await expect(messages(page).getByTestId('bubble-them').last()).toHaveText('Gate C, by the info tent', SYNC);
    await page.waitForTimeout(2_000);
    await expect(line(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __lineSeen?: boolean }).__lineSeen)).toBe(false);
  });

  test('the line, the Message button and an Activity message land at the thread with the keyboard down; a row, a card and an answer at the top', async ({ page, context, browser }) => {
    test.slow();
    const res = await context.request.post('/api/activity/read', { headers: { origin: BASE }, data: { all: true } });
    expect(res.status()).toBe(200);
    const asked = await createRequest(page.request);
    const answered = await createRequest(page.request);
    await withMedical(browser, async (med) => {
      await say(med, asked.id, 'Any tattoos or marks?');
      await inMedical(med, answered.id);
    });

    // Activity first (opening a request reads its row): the message's row at the thread, the answer's at the top.
    await page.goto('/');
    const bell = page.getByTestId('activity-bell').filter({ visible: true });
    await expect(bell).toHaveAccessibleName(/Activity, [1-9]\d* unread/, SYNC);
    await bell.click();
    const sheet = page.getByRole('dialog', { name: 'Activity' });
    await sheet.locator('[data-testid="activity-row"][data-kind="message"]').first().click();
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(asked.id);
    await expectAtThread(page);
    await expect(composer(page)).not.toBeFocused();
    await page.goto('/');
    await bell.click();
    await page.getByRole('dialog', { name: 'Activity' }).locator('[data-testid="activity-row"][data-kind="in_medical"]').first().click();
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(answered.id);
    await expectAtTop(page);

    // The line.
    await page.goto(`/?r=${asked.id}`);
    await expect(line(page)).toBeVisible(SYNC);
    await expect(threadHead(page)).not.toBeInViewport();
    await line(page).click();
    await expectAtThread(page);
    await expect(composer(page)).not.toBeFocused();
    await expect(threadHead(page)).toBeFocused();

    // My requests → Message.
    await page.goto('/?view=mine');
    const card = page.locator(`[data-testid="mine-card"]:has([data-request-id="${asked.id}"])`);
    await expect(card).toBeVisible(SYNC);
    await card.getByTestId('message-button').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(asked.id);
    await expectAtThread(page);
    await expect(composer(page)).not.toBeFocused();

    // Pending → the card itself opens at the top.
    await page.goto('/?view=pending');
    const check = page.locator(`[data-testid="check-card"]:has([data-request-id="${asked.id}"])`);
    await expect(check).toBeVisible(SYNC);
    await check.locator(`[data-request-id="${asked.id}"]`).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(asked.id);
    await expectAtTop(page);

    // All → a row opens at the top.
    await page.goto('/');
    const row = page.locator(`[data-request-id="${answered.id}"]`).first();
    await expect(row).toBeVisible(SYNC);
    await row.click();
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(answered.id);
    await expectAtTop(page);
  });

  test("a message's notification lands at the thread, in place or as a new page; an old address at the top", async ({ page, browser }) => {
    test.slow();
    const r = await createRequest(page.request);
    await withMedical(browser, (med) => say(med, r.id, 'Any tattoos or marks?'));

    // The app is open: the worker asks the page to open "/?r=<id>&to=thread" in place.
    await page.goto('/');
    await expect(page.locator('[data-view]').first()).toBeVisible(SYNC);
    await expect.poll(() => workerAsksToOpen(page, `/?r=${r.id}&to=thread`), SYNC).toEqual({ ok: true });
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(r.id);
    await expectAtThread(page);
    await expect(composer(page)).not.toBeFocused();

    // A new page (no window was open, or one the worker navigated): the same, and `to` leaves the address.
    await page.goto(`/?r=${r.id}&to=thread`);
    await expectAtThread(page);
    await expect.poll(() => new URL(page.url()).searchParams.get('to')).toBeNull();
    expect(new URL(page.url()).searchParams.get('r')).toBe(r.id);
    await expect(composer(page)).not.toBeFocused();

    // An old "/?r=<id>" (an earlier build's notification, a shared link): the top.
    await page.goto(`/?r=${r.id}`);
    await expectAtTop(page);
  });

  test("a jump to a long thread keeps medical's message field above the action bar (390 × 844 and 390 × 664)", async ({ page, browser }) => {
    test.slow();
    // In medical (medical's three quick lines wrap to two rows, T3), and 8 messages that alternate (8 run labels, T5):
    // the thread is at its height cap.
    const r = await createRequest(page.request);
    await withMedical(browser, async (med) => {
      await inMedical(med, r.id);
      for (let i = 1; i <= 8; i += 1) await say(i % 2 ? med : page.request, r.id, `Synthetic handover note ${i}`);
    });
    const fieldAboveBar = async (p: Page, label: string, plainLandingHides: boolean) => {
      await p.waitForTimeout(800);
      const field = (await composer(p).boundingBox())!;
      const bar = (await p.getByTestId('profile-actions').boundingBox())!;
      expect(field.y + field.height, `${label}: the field ends above the action bar`).toBeLessThanOrEqual(bar.y);
      await expect(composer(p)).toBeInViewport({ ratio: 1 });
      await expect(messages(p).getByTestId('bubble-them').last()).toBeInViewport();
      await expect(composer(p)).not.toBeFocused();
      if (plainLandingHides) {
        // The case this guards: with the heading just under the top bar, the field would sit under the action bar.
        const section = (await messages(p).boundingBox())!;
        expect(field.y + field.height - section.y + 56, `${label}: the section is taller than the room`).toBeGreaterThan(bar.y);
      }
    };
    for (const height of [844, 664]) {
      const latest = `Synthetic handover note ${height}`;
      await say(page.request, r.id, latest);
      const ctx = await newSignedInContext(browser, MED, { baseURL: BASE, ...devices['iPhone 14'], viewport: { width: 390, height }, serviceWorkers: 'block' });
      const p = await ctx.newPage();
      try {
        // In place: the line (unread), with the thread already shown.
        await p.goto(`/?r=${r.id}`);
        await expect(messages(p).getByTestId('bubble-them').last()).toHaveText(latest, SYNC);
        await expect(line(p)).toBeVisible(SYNC);
        await line(p).click();
        await fieldAboveBar(p, `${height} line`, height === 664);
        // A notification on a new page: the thread loads under the jump, and it lands again once it shows.
        await p.goto(`/?r=${r.id}&to=thread`);
        await expect(messages(p).getByTestId('bubble-them').last()).toHaveText(latest, SYNC);
        await fieldAboveBar(p, `${height} notification`, height === 664);
        // (2026-11-08) The page scrolled there, not a box inside it.
        expect(await threadBox(p), `${height}`).toEqual({ overflowY: 'visible', scrolls: false });
        expect(await pageY(p), `${height}`).toBeGreaterThan(0);
      } finally {
        await ctx.close();
      }
    }
  });

  test('a jump whose thread arrives 5 s late still lands at the newest, the field above the action bar', async ({ page, browser }) => {
    test.slow();
    // No thread cache on this page, and festival LTE: the thread's GET takes 5 s (the client gives up at 12 s).
    const r = await createRequest(page.request);
    await longThread(browser, r.id, 12, 'Synthetic late note');
    await page.route(
      (url) => url.pathname === `/api/requests/${r.id}/messages`,
      async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        await route.continue().catch(() => undefined);
      },
    );
    const bubbles = messages(page).locator('[data-testid^="bubble-"]');
    await page.goto(`/?r=${r.id}&to=thread`);
    await expect(messages(page).getByRole('status', { name: 'Loading messages' })).toBeVisible(SYNC);
    await expect(bubbles).toHaveCount(12, SYNC);
    await page.waitForTimeout(1_200);
    await expect(bubbles.last()).toHaveText('Synthetic late note 12');
    await expect(bubbles.last()).toBeInViewport({ ratio: 1 });
    await expectFieldAboveBar(page, 'late thread');
    await expect(composer(page)).not.toBeFocused();
  });

  test('the thread is part of the page: a swipe that starts on it scrolls the page down and up', async ({ page, browser, browserName }) => {
    test.slow();
    const r = await createRequest(page.request);
    await longThread(browser, r.id, 12);
    const touch = browserName === 'chromium';
    const ctx = touch ? null : await newSignedInContext(browser, FOH, { baseURL: BASE, viewport: { width: 390, height: 844 }, isMobile: false, hasTouch: false, serviceWorkers: 'block' });
    const p = ctx ? await ctx.newPage() : page;
    try {
      await p.goto(`/?r=${r.id}`);
      const bubbles = messages(p).locator('[data-testid^="bubble-"]');
      await expect(bubbles).toHaveCount(12, SYNC);
      expect(await threadBox(p)).toEqual({ overflowY: 'visible', scrolls: false });
      // The thread taller than the screen, its middle on screen; a finger on it would scroll the page.
      const thread = (await messages(p).getByTestId('thread').boundingBox())!;
      expect(thread.height).toBeGreaterThan(p.viewportSize()!.height * 0.75);
      await bubbleAt(p, bubbles.nth(5), 260);
      expect(await scrollsUnder(p, bubbles.nth(5))).toBe('page');
      const start = await pageY(p);

      // The finger moves up on a bubble: the page scrolls down.
      await swipeOnThread(p, touch, bubbles.nth(5), -220);
      const down = await pageY(p);
      expect(down - start, 'a swipe up on the thread scrolls the page down').toBeGreaterThan(80);
      // And down: the page scrolls back up.
      await swipeOnThread(p, touch, bubbles.nth(4), 220);
      expect(down - (await pageY(p)), 'a swipe down on the thread scrolls the page up').toBeGreaterThan(80);
      // Nothing inside the thread moved on its own.
      expect(await messages(p).getByTestId('thread').evaluate((el) => el.scrollTop)).toBe(0);
    } finally {
      await ctx?.close();
    }
  });

  test('a new message: the page follows at the end of the thread; higher up, "New messages" and the page stays put', async ({ page, browser }) => {
    test.slow();
    const r = await createRequest(page.request);
    await longThread(browser, r.id, 12);
    const bubbles = messages(page).locator('[data-testid^="bubble-"]');
    const pill = messages(page).getByTestId('new-messages');

    // At the end (a jump): the next message comes into view with the field under it, above the action bar.
    await page.goto(`/?r=${r.id}&to=thread`);
    await expect(bubbles).toHaveCount(12, SYNC);
    await page.waitForTimeout(1_200);
    await expectFieldAboveBar(page, 'landed');
    await withMedical(browser, (med) => say(med, r.id, 'Synthetic follow-up at the end'));
    await expect(bubbles.last()).toHaveText('Synthetic follow-up at the end', SYNC);
    await page.waitForTimeout(1_200);
    await expect(bubbles.last()).toBeInViewport({ ratio: 1 });
    await expectFieldAboveBar(page, 'followed');
    await expect(pill).toHaveCount(0);

    // Higher up (the thread's first messages on screen, its end below): nothing moves, the pill shows above the bar.
    await bubbleAt(page, bubbles.nth(1), 200);
    await page.waitForTimeout(400);
    const before = await pageY(page);
    const top = (await bubbles.nth(1).boundingBox())!.y;
    await withMedical(browser, (med) => say(med, r.id, 'Synthetic note while reading up'));
    await expect(bubbles.last()).toHaveText('Synthetic note while reading up', SYNC);
    await expect(pill).toBeVisible();
    await page.waitForTimeout(600);
    expect(await pageY(page), 'the page did not move').toBe(before);
    expect(Math.abs((await bubbles.nth(1).boundingBox())!.y - top)).toBeLessThanOrEqual(1);
    await expect(bubbles.last()).not.toBeInViewport();
    await expect(pill).toBeInViewport({ ratio: 1 });
    const pillBox = (await pill.boundingBox())!;
    expect(pillBox.y + pillBox.height, 'the pill sits above the action bar').toBeLessThanOrEqual((await page.getByTestId('profile-actions').boundingBox())!.y);

    // The pill: to the newest, with the field above the bar; the pill goes.
    await pill.click();
    await expect(pill).toHaveCount(0);
    await page.waitForTimeout(1_200);
    await expect(bubbles.last()).toBeInViewport({ ratio: 1 });
    await expectFieldAboveBar(page, 'after the pill');
  });

  test('"Earlier messages" keeps the message on screen where it was, after the reader scrolls during a slow load; a failed load moves nothing', async ({ page, browser }) => {
    test.slow();
    const r = await createRequest(page.request);
    await withMedical(browser, (med) => say(med, r.id, 'Synthetic latest note'));
    // Older pages, served in place of the server's (the rate limit keeps a real 100-message thread out of reach):
    // the latest page gets 20 synthetic older messages and says there are more; the page before it, 20 more.
    const base = Date.now() - 3 * 60 * 60_000;
    const synthetic = (from: number, label: string) =>
      Array.from({ length: 20 }, (_, i) => ({
        id: randomUUID(),
        staff: 'TEST-RO Syn Medic · Medical',
        by: 'TEST-RO S.',
        team: 'Medical',
        body: `${label} ${i + 1}`,
        createdAt: new Date(from + i * 20_000).toISOString(),
        mine: false,
        clientMutationId: randomUUID(),
      }));
    const earliest = synthetic(base, 'Synthetic earliest note');
    const earlier = synthetic(base + 60 * 60_000, 'Synthetic earlier note');
    // The older page waits for the test (a slow network): it fails the first time, and is served the second.
    let olderAsked = 0;
    let release: (fail: boolean) => void = () => undefined;
    await page.route(
      (url) => url.pathname === `/api/requests/${r.id}/messages`,
      async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const older = new URL(route.request().url()).searchParams.has('beforeAt');
        if (older) {
          olderAsked += 1;
          const fail = await new Promise<boolean>((resolve) => (release = resolve));
          if (fail) return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Synthetic failure' } } });
        }
        const res = await route.fetch();
        const real = (await res.json()) as ThreadPage;
        await route.fulfill({ response: res, json: older ? { ...real, messages: earliest, hasEarlier: false } : { ...real, messages: [...earlier, ...real.messages], hasEarlier: true } });
      },
    );
    await page.goto(`/?r=${r.id}`);
    const bubbles = messages(page).locator('[data-testid^="bubble-"]');
    await expect(bubbles).toHaveCount(21, SYNC);
    const button = messages(page).getByRole('button', { name: 'Earlier messages' });
    await expect(button).toBeVisible();
    // The button near the top of the screen, the first message under it.
    const first = messages(page).getByTestId('bubble-them').filter({ hasText: /^Synthetic earlier note 1$/ });
    const scrollBy = (dy: number) => page.evaluate((by) => window.scrollBy({ top: by, behavior: 'instant' }), dy);

    // A failed load, the reader scrolling down meanwhile: the page stays where they put it.
    await bubbleAt(page, first, 220);
    await page.waitForTimeout(300);
    await button.click();
    await expect.poll(() => olderAsked).toBe(1);
    await scrollBy(240);
    await page.waitForTimeout(300);
    const readingAt = await pageY(page);
    release(true);
    await expect(page.locator('.lp-toast').filter({ hasText: "Couldn't load earlier messages" })).toBeVisible(SYNC);
    await page.waitForTimeout(500);
    expect(Math.abs((await pageY(page)) - readingAt), 'a failed load moves nothing').toBeLessThanOrEqual(1);
    await expect(bubbles).toHaveCount(21);
    await expect(button).toBeVisible();

    // Again, served this time: the reader scrolls down while it loads, and the message stays where they left it.
    await bubbleAt(page, first, 220);
    await page.waitForTimeout(300);
    await button.click();
    await expect.poll(() => olderAsked).toBe(2);
    await scrollBy(160);
    await page.waitForTimeout(300);
    const y = (await first.boundingBox())!.y;
    const scrolled = await pageY(page);
    release(false);
    await expect(bubbles).toHaveCount(41, SYNC);
    await expect(button).toHaveCount(0);
    await page.waitForTimeout(500);
    // The page moved down by what was added above; the message on screen did not move.
    expect(Math.abs((await first.boundingBox())!.y - y), 'the first message stays in place').toBeLessThanOrEqual(2);
    expect(await pageY(page)).toBeGreaterThan(scrolled + 300);
    // The older messages sit above, off the screen; the one right above the kept message is the last of them.
    await expect(messages(page).getByTestId('bubble-them').filter({ hasText: /^Synthetic earliest note 1$/ })).not.toBeInViewport();
  });

  test('axe and the 44 px line, light and dark', async ({ page, browser }) => {
    test.slow();
    const r = await createRequest(page.request);
    await withMedical(browser, (med) => say(med, r.id, 'Any tattoos or marks?'));
    for (const theme of ['light', 'dark'] as const) {
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('lp-theme', t);
        } catch {
          // ignore
        }
      }, theme);
      await page.goto(`/?r=${r.id}`);
      await expect(line(page)).toBeVisible(SYNC);
      await page.waitForTimeout(500);
      const found = (await axeViolations(page)).map((v: AxeFinding) => `${v.rule} · ${v.target} · ${v.summary}`);
      expect(found, theme).toEqual([]);
      const box = (await line(page).boundingBox())!;
      expect(box.height, theme).toBeGreaterThanOrEqual(44);
    }
  });

  test('no overflow at 375–1440 px, light and dark', async ({ page, browser }) => {
    test.slow();
    const r = await createRequest(page.request);
    await withMedical(browser, (med) => say(med, r.id, 'Any tattoos or marks? Anything that stands out, like a tattoo, a piercing or a bracelet'));
    for (const theme of ['light', 'dark'] as const) {
      for (const width of OVERFLOW_WIDTHS) {
        const phone = width < 768;
        const ctx = await newSignedInContext(browser, FOH, { viewport: { width, height: 900 }, isMobile: phone, hasTouch: phone });
        await ctx.addInitScript((t) => {
          try {
            localStorage.setItem('lp-theme', t);
          } catch {
            // ignore
          }
        }, theme);
        const p = await ctx.newPage();
        try {
          await p.goto(`/?r=${r.id}`);
          await expect(line(p)).toBeVisible(SYNC);
          // (T2) At most two lines (12 + 2 × 20 + 12 px), cut with an ellipsis inside the button; on a phone this
          // long question takes both (it is no longer cut to one).
          const box = (await line(p).boundingBox())!;
          expect(box.height, `${width} ${theme}`).toBeLessThanOrEqual(66);
          if (phone) expect(box.height, `${width} ${theme}: two lines`).toBeGreaterThan(56);
          // The time sits at the line's right, before the ⌄, inside the button.
          const time = (await line(p).getByTestId('preview-time').boundingBox())!;
          const go = (await line(p).locator('svg').last().boundingBox())!;
          expect(time.x, `${width} ${theme}`).toBeGreaterThan(box.x + box.width / 2);
          expect(time.x + time.width, `${width} ${theme}`).toBeLessThanOrEqual(go.x + 1);
          expect(go.x + go.width, `${width} ${theme}`).toBeLessThanOrEqual(box.x + box.width + 1);
          await expectNoOverflow(p, '[data-testid="profile"]', `request ${width} px ${theme}`);
        } finally {
          await ctx.close();
        }
      }
    }
  });
});

test.describe('desk', () => {
  test.use(DESK);

  test("a Pending card's Message and the line land at the thread with the composer focused; the order in the pane", async ({ page, browser }) => {
    test.slow();
    const r = await createRequest(page.request);
    await withMedical(browser, (med) => say(med, r.id, 'Any tattoos or marks?'));

    await page.goto('/?view=pending');
    const card = page.locator(`[data-testid="check-card"]:has([data-request-id="${r.id}"])`);
    await expect(card).toBeVisible(SYNC);
    await card.getByTestId('message-button').click();
    await expect(page.getByTestId('desk-pane')).toBeVisible();
    await expectAtThread(page);
    await expect(composer(page)).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // (T4) In the desk pane the thread keeps its scroll to itself.
    expect(await messages(page).getByTestId('thread').evaluate((el) => getComputedStyle(el).overscrollBehaviorY)).toBe('contain');

    // Back to its top: the order, then the line.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.querySelector('[data-testid="desk-pane"] [data-testid="profile"]')?.parentElement?.scrollTo(0, 0);
    });
    await expect(line(page)).toBeVisible(SYNC);
    expect(ascending(await order(page, true))).toBe(true);
    const acts = (await page.getByTestId('profile-actions').boundingBox())!;
    expect((await line(page).boundingBox())!.y).toBeGreaterThan(acts.y);
    await line(page).click();
    await expectAtThread(page);
    await expect(composer(page)).toBeFocused();
  });

  test('the pane keeps the thread in its own box: it opens at the newest, and the wheel scrolls it, not the pane or the page', async ({ page, browser }) => {
    test.slow();
    const r = await createRequest(page.request);
    await longThread(browser, r.id, 14);
    await page.goto(`/?r=${r.id}`);
    await expect(page.getByTestId('desk-pane')).toBeVisible(SYNC);
    const bubbles = messages(page).locator('[data-testid^="bubble-"]');
    await expect(bubbles).toHaveCount(14, SYNC);
    const thread = messages(page).getByTestId('thread');
    expect(await threadBox(page)).toEqual({ overflowY: 'auto', scrolls: true });
    expect(await thread.evaluate((el) => getComputedStyle(el).overscrollBehaviorY)).toBe('contain');
    // At the newest.
    await expect.poll(() => thread.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))).toBeLessThanOrEqual(2);
    // Bring the whole thread on screen in the pane, then wheel up over it.
    await page.evaluate(() => {
      const pane = document.querySelector('[data-testid="desk-pane"] [data-testid="profile"]')?.parentElement;
      const section = document.querySelector('[data-testid="messages"]');
      if (pane && section) pane.scrollTop += section.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    });
    await page.waitForTimeout(300);
    const paneTop = await scrollOf(page);
    const before = await thread.evaluate((el) => el.scrollTop);
    expect(await scrollsUnder(page, bubbles.nth(10))).toBe('thread');
    const box = (await thread.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -200);
    await expect.poll(() => thread.evaluate((el) => el.scrollTop)).toBeLessThan(before - 100);
    expect(await scrollOf(page), 'the pane did not scroll').toBe(paneTop);
    expect(await page.evaluate(() => window.scrollY), 'nor the page').toBe(0);
  });

  test("a row's message lane lands at the thread with the composer focused; the rest of a row at the top", async ({ page, browser }) => {
    test.slow();
    const a = await createRequest(page.request);
    const b = await createRequest(page.request);
    await withMedical(browser, async (med) => {
      await say(med, a.id, 'Any tattoos or marks?');
      await say(med, b.id, 'Any tattoos or marks?');
    });

    await page.goto('/');
    const rowA = page.locator(`[data-request-id="${a.id}"]`).first();
    // (Message lane) The blue bubble leads the row, before #; a click on it lands at the thread.
    await expect(rowA.getByTestId('message-mark')).toHaveText('1', SYNC);
    await expect(rowA.getByTestId('message-mark')).toHaveAttribute('data-mark', 'unread');
    await rowA.getByTestId('message-mark').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(a.id);
    await expectAtThread(page);
    await expect(composer(page)).toBeFocused();
    // Only the pane scrolled: the page (and the list beside the pane) kept its place.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    const rowB = page.locator(`[data-request-id="${b.id}"]`).first();
    await expect(rowB.getByTestId('message-mark')).toHaveText('1', SYNC);
    await rowB.locator('[data-col="status"]').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(b.id);
    await expectAtTop(page);
    await expect(composer(page)).not.toBeFocused();
    // B had unread messages: its line is there, at the top.
    await expect(line(page)).toBeVisible();
  });
});
