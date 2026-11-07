import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import type { RequestDetail, RequestSummary } from '../../lib/api-types';
import { formatCreatedTime } from '../../lib/format';
import { loadTestEnv, testBaseUrl } from '../../scripts/test-env.mjs';
import { confirmCrop } from './helpers/photo';
import { syntheticPng } from './helpers/png';
import { newSignedInContext, signedInAs } from './helpers/session';
import { syncRows } from './helpers/sync';

// List views end to end (spec §8 List views, §9.4 "it appears in All and My requests", "a second context
// sees it in Pending … taps In medical", "Friend coming → Reunited", "undo", "search", "a tile filtering
// All"), with log option B and the header declutter (2026-11-06): the large title is the view menu, the
// number column, Created with AM/PM, Updated "—" until something changes, every closed request folded
// into "Archived N" (Brian, 2026-11-06), Alerts in the avatar menu, and no badge on the avatar unless the
// connection is down; Jeffrey's brand row (2026-11-06 10:31, made compact with an X that hides it on this
// device, 2026-11-06 afternoon) over All requests only (Pending v8, Brian 2026-11-06 afternoon: Pending and
// My requests open with their large title; Pending v9.1 is one page, Waiting for check then Friend coming,
// tests/e2e/pending-v8.spec.ts and pending-v9.spec.ts have the rest); and the live indicator under the title.
// Runs against
// the real store and API on the local stack. Every row is synthetic and unique to this run (TEST-L-<tag>);
// nothing is truncated or reset, and the requests a test opened are closed after it.

const BASE = testBaseUrl();
const STAFF = { staffName: 'TEST-L Lists', team: 'Medical' };
const TAG = `TEST-L-${Date.now().toString(36)}`;
const TZ = (loadTestEnv() as Record<string, string | undefined>)['EVENT_TIMEZONE'] || 'America/New_York';
let seq = 0;

const opened: Array<{ id: string; request: APIRequestContext }> = [];

async function createRequest(page: Page, extra: Record<string, unknown> = {}): Promise<RequestSummary> {
  seq += 1;
  const res = await page.request.post('/api/requests', {
    headers: { origin: BASE },
    data: {
      clientMutationId: randomUUID(),
      reportingLocation: 'FA 3 – Kinetic',
      name: `${TAG} P${seq}`,
      age: 21,
      gender: 'Female',
      clothing: `Synthetic ${TAG} jacket ${seq}`,
      contactName: `${TAG} Friend`,
      ...extra,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const request = ((await res.json()) as { request: RequestSummary }).request;
  opened.push({ id: request.id, request: page.request });
  return request;
}

async function setStatus(page: Page, r: RequestSummary, status: string, kind: string): Promise<RequestSummary> {
  const res = await page.request.post(`/api/requests/${r.id}/status`, { headers: { origin: BASE }, data: { status, expectedVersion: r.rowVersion, kind } });
  expect(res.ok(), `status → ${res.status()}`).toBe(true);
  return ((await res.json()) as { request: RequestSummary }).request;
}

/** (F5) Not in medical, final: the first Not found only puts it on a "Not found yet" hold; the second closes it. */
async function notFound(page: Page, r: RequestSummary): Promise<RequestSummary> {
  const held = await setStatus(page, r, 'Checked – Not Found', 'answer');
  return setStatus(page, held, 'Checked – Not Found', 'answer');
}

const row = (page: Page, id: string) => page.locator(`[data-request-id="${id}"]`);
const cell = (page: Page, id: string, col: string) => row(page, id).locator(`[data-col="${col}"]`);
const checkCard = (page: Page, id: string) => page.locator(`[data-testid="check-card"]:has([data-request-id="${id}"])`);
const comingCard = (page: Page, id: string) => page.locator(`[data-testid="friend-coming-card"]:has([data-request-id="${id}"])`);
const lp = (r: RequestSummary) => `LP-${String(r.caseNumber).padStart(4, '0')}`;
const fold = (page: Page) => page.getByTestId('closed-fold');

/** Back to All through the large-title view menu (there is no separate ×). */
async function showAll(page: Page) {
  await page.getByTestId('view-switcher').click();
  await page.getByRole('menuitemradio', { name: /^All requests \d+$/ }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
}

let errors: string[];

// Signed in once through POST /api/session (A17); every test's page is the liaison.
signedInAs(STAFF);

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('console', (msg) => {
    // Photo thumbnails of seeded rows may 404 locally; anything else is a bug.
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
});

test.afterEach(async () => {
  // Leave nothing open in Pending for the other specs (best effort).
  for (const { id, request } of opened.splice(0)) {
    try {
      const r = (await (await request.get(`/api/requests/${id}`)).json()) as RequestDetail;
      if (r.status === 'Added') {
        await request.post(`/api/requests/${id}/cancel`, { headers: { origin: BASE }, data: { expectedVersion: r.rowVersion } });
      } else if (r.status === 'Found – Awaiting Reunion') {
        await request.post(`/api/requests/${id}/status`, {
          headers: { origin: BASE },
          data: { status: 'Reunited – Closed', expectedVersion: r.rowVersion, kind: 'reunite' },
        });
      }
    } catch {
      // The context may already be closed.
    }
  }
  expect(errors).toEqual([]);
});

test('All: the large title is the view menu; a new request is the top row and opens the profile', async ({ page }) => {
  const r = await createRequest(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: /^All requests \d+, change view$/ })).toBeVisible();
  await expect(row(page, r.id)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="request-list"] [data-request-id]').first()).toHaveAttribute('data-request-id', r.id);
  // One quiet column header: # · Friend · Status · Created · Updated.
  await expect(page.getByTestId('log-columns')).toHaveText(/^#\s*Friend\s*Status\s*Created\s*Updated$/);
  await expect(cell(page, r.id, 'number')).toHaveText(String(r.caseNumber));
  await expect(cell(page, r.id, 'name')).toHaveText(r.name);
  // iPhone 14 is 390 px wide: under 430 px "Waiting for check" reads "Waiting" (the blue ring says the rest,
  // the row's sentence says it in full), so the name keeps its room.
  await expect(cell(page, r.id, 'status')).toHaveText('Waiting', { useInnerText: true });
  await page.setViewportSize({ width: 430, height: 932 });
  await expect(cell(page, r.id, 'status')).toHaveText('Waiting for check', { useInnerText: true });
  // The header declutter: no "Newest first", no ×, no bell, no live dot while the app is live.
  await expect(page.getByText('Newest first')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Back to all requests' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New-request alerts' })).toHaveCount(0);
  await expect(page.getByTestId('connection-indicator')).toHaveCount(0);
  await expect(page.getByTestId('live-dot')).toHaveCount(0);
  await row(page, r.id).click();
  await expect(page).toHaveURL(new RegExp(`\\?r=${r.id}$`));
});

const brand = (page: Page) => page.getByTestId('brand-card');

/** The brand row as it is drawn now: box, background, every text colour, the logos. */
async function brandLook(page: Page) {
  return brand(page).evaluate((el) => {
    const cs = getComputedStyle(el);
    const title = el.querySelector<HTMLElement>('p[class*="title"]')!;
    return {
      box: el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number },
      background: cs.backgroundImage,
      shadow: cs.boxShadow,
      colors: [...el.querySelectorAll('p, p *')].map((n) => getComputedStyle(n).color),
      titleSize: Number.parseFloat(getComputedStyle(title).fontSize),
      titleHeight: title.getBoundingClientRect().height,
      edcFilter: getComputedStyle(el.querySelector('img[alt="EDC Orlando"]')!).filter,
      logos: [...el.querySelectorAll('img')].map((img) => ({ alt: img.alt, loaded: img.complete && img.naturalWidth > 0, height: img.getBoundingClientRect().height })),
      // Shown text lines only (one of the two date lines is display: none at any width).
      shown: [...el.querySelectorAll<HTMLElement>('p')].filter((p) => p.offsetParent !== null).map((p) => p.innerText),
      // The page around the row: the sticky bar's background (the theme's page colour).
      page: getComputedStyle(document.querySelector('[data-testid="view-switcher"]')!.closest('header')!.parentElement!).backgroundColor,
    };
  });
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => localStorage.setItem('lp-theme', t), theme);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
  await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 10_000 });
}

test('brand row on All only: one compact row with the logos, the title and the dates; dark in both themes; not on Pending, My requests or Search', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 10_000 });
  const card = brand(page);
  await expect(card).toBeVisible();
  await expect(card.getByRole('img', { name: 'EDC Orlando' })).toBeVisible();
  await expect(card.getByRole('img', { name: 'Ground Control' })).toBeVisible();
  await expect(card.locator('p[class*="title"]')).toHaveText('Is my friend in medical?');
  await expect(card.locator('[class*="accent"]')).toHaveText('in medical?');
  await expect(card.locator('[class*="accent"]')).toHaveCSS('color', 'rgb(142, 240, 231)');
  await expect(card.locator('[class*="accent"]')).toHaveCSS('font-weight', '500');
  await expect(card.locator('p[class*="title"]')).toHaveCSS('font-size', '16px');
  await expect(card.locator('p[class*="title"]')).toHaveCSS('font-weight', '700');
  await expect(card.locator('[class*="datesShort"]')).toHaveText('NOV 6–8', { useInnerText: true });
  await expect(card.locator('[class*="datesShort"]')).toHaveCSS('color', 'rgb(205, 185, 240)');
  await expect(card.locator('[class*="datesShort"]')).toHaveCSS('font-size', '10px');
  // No "event operations" / "event ops" anywhere, and no credit line or rings.
  await expect(card).not.toContainText(/event op/i);
  await expect(page.getByText(/event op/i)).toHaveCount(0);
  await expect(card).not.toContainText('Built by');
  await expect(card.locator('[class*="orbit"]')).toHaveCount(0);
  // The X, named for what it does; the row adds no heading (the view menu title is still the one h1).
  await expect(card.getByRole('button', { name: 'Hide header' })).toBeVisible();
  await expect(card.getByRole('heading')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

  // iPhone 14 (390 px): one row about 56 px tall with a 12 px margin, the title on one line, the logos at
  // their size, EDC made white, no glow around it.
  await expect.poll(async () => (await brandLook(page)).logos.every((l) => l.loaded)).toBe(true);
  const light = await brandLook(page);
  expect(light.box.x).toBe(12);
  expect(light.box.y).toBe(12);
  expect(light.box.width).toBe(390 - 24);
  expect(light.box.height).toBeGreaterThanOrEqual(52);
  expect(light.box.height).toBeLessThanOrEqual(64);
  expect(light.titleHeight).toBeLessThan(light.titleSize * 1.5);
  expect(light.shown).toEqual(['Is my friend in medical?', 'NOV 6–8']);
  expect(light.logos.map((l) => [l.alt, l.height])).toEqual([
    ['EDC Orlando', 19],
    ['Ground Control', 16],
  ]);
  expect(light.edcFilter).toContain('invert(1)');
  expect(light.background).toContain('linear-gradient');
  expect(light.shadow).toBe('none');
  // The X: 30 px, inside the row's right edge, its middle on the row's middle.
  const x = (await card.getByRole('button', { name: 'Hide header' }).boundingBox())!;
  expect(x.width).toBe(30);
  expect(x.x + x.width).toBeLessThanOrEqual(light.box.x + light.box.width);
  expect(Math.abs(x.y + x.height / 2 - (light.box.y + light.box.height / 2))).toBeLessThan(1);

  // The sticky bar follows the row: the view menu title, search and the avatar on one row under it.
  const title = (await page.getByTestId('view-switcher').boundingBox())!;
  const search = (await page.getByRole('button', { name: 'Search' }).boundingBox())!;
  const avatar = (await page.getByTestId('account-trigger').boundingBox())!;
  expect(title.y).toBeGreaterThan(light.box.y + light.box.height);
  expect(Math.abs(search.y + search.height / 2 - (avatar.y + avatar.height / 2))).toBeLessThan(2);

  // Always dark: the same row in the dark and the light theme (only the page around it changes).
  await setTheme(page, 'dark');
  const dark = await brandLook(page);
  await setTheme(page, 'light');
  const lightAgain = await brandLook(page);
  expect(dark.page).not.toBe(lightAgain.page);
  for (const look of [dark, lightAgain]) {
    expect({ background: look.background, colors: look.colors, box: look.box }).toEqual({
      background: light.background,
      colors: light.colors,
      box: light.box,
    });
  }

  // It scrolls away with the page; the sticky bar stays at the top.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('main')!.style.paddingBottom = '2400px';
    window.scrollTo(0, 700);
  });
  await expect
    .poll(async () => {
      const box = (await card.boundingBox())!;
      return box.y + box.height;
    })
    .toBeLessThan(0);
  const stuck = (await page.getByTestId('view-switcher').boundingBox())!;
  expect(stuck.y).toBeGreaterThanOrEqual(0);
  expect(stuck.y).toBeLessThan(60);

  // All with a filter is still All requests: the row is there.
  await page.goto(`/?status=${encodeURIComponent('Added')}`);
  await expect(page.getByTestId('status-chip')).toBeVisible();
  await expect(brand(page)).toBeVisible();

  // Pending and My requests start at their large title (Pending v8), at the top of the page — under the
  // alerts reminder while alerts don't work on this phone yet (F4: here, a Safari tab). Search keeps its own bar.
  for (const url of ['/?view=pending', '/?view=mine']) {
    await page.goto(url);
    await expect(page.getByTestId('view-switcher')).toBeVisible();
    await expect(brand(page), url).toHaveCount(0);
    const reminder = page.getByTestId('alerts-banner');
    const top = (await reminder.count()) ? (await reminder.boundingBox())!.y + (await reminder.boundingBox())!.height : 0;
    expect((await page.getByTestId('view-switcher').boundingBox())!.y - top, url).toBeLessThan(40);
  }
  await page.goto('/?q=');
  await expect(page.getByRole('searchbox', { name: 'Search requests' })).toBeVisible();
  await expect(brand(page)).toHaveCount(0);

  // Wider phone screens (720 px up to the desk's 768): the same single row, wider, with "NOVEMBER 6–8, 2026"
  // beside the title.
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.goto('/');
  await expect(brand(page)).toBeVisible();
  await expect.poll(async () => (await brandLook(page)).logos.every((l) => l.loaded)).toBe(true);
  const wide = await brandLook(page);
  expect(wide.box.width).toBe(760 - 24);
  expect(wide.box.height).toBeLessThanOrEqual(64);
  expect(wide.titleHeight).toBeLessThan(wide.titleSize * 1.5);
  expect(wide.shown).toEqual(['Is my friend in medical?', 'NOVEMBER 6–8, 2026']);
  const t = (await brand(page).locator('p[class*="title"]').boundingBox())!;
  const d = (await brand(page).locator('[class*="datesLong"]').boundingBox())!;
  expect(d.x).toBeGreaterThan(t.x + t.width);
  expect(Math.abs(d.y + d.height - (t.y + t.height))).toBeLessThan(6);

  // From 768 px the desk shell draws the brand (the same row over All requests, above its top bar,
  // tests/e2e/desk-shell.spec.ts) and the list's chrome (its rail / sidebar and top bar), so the list has no
  // row of its own.
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto('/');
  await expect(page.getByTestId('desk-rail')).toBeVisible();
  await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-view] [data-testid="brand-card"]')).toHaveCount(0);
  await expect(brand(page)).toHaveCount(1);
  await expect(page.getByTestId('desk-brand').getByTestId('brand-card')).toBeVisible();
});

test('the X hides the brand row on this device: it stays hidden after a reload (never drawn), and Show header brings it back', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 10_000 });
  const before = (await page.getByTestId('view-switcher').boundingBox())!;
  // While it shows, the avatar menu has no Show header.
  await page.getByTestId('account-trigger').click();
  const menu = page.getByRole('dialog', { name: 'Account' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Show header' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await brand(page).getByRole('button', { name: 'Hide header' }).click();
  await expect(brand(page)).toHaveCount(0);
  // The view starts at its title now (under F4's alerts reminder while alerts don't work on this phone yet: here,
  // a Safari tab on an iPhone).
  const after = (await page.getByTestId('view-switcher').boundingBox())!;
  expect(after.y).toBeLessThan(before.y);
  const reminder = page.getByTestId('alerts-banner');
  const top = (await reminder.count()) ? (await reminder.boundingBox())!.y + (await reminder.boundingBox())!.height : 0;
  expect(after.y - top).toBeLessThan(40);
  expect(await page.evaluate(() => localStorage.getItem('lp-brand-hidden'))).toBe('1');

  // After a reload it is never drawn, not even for a frame before the prefs are read. Checked before every
  // frame is painted (a rAF callback runs only once the page can render): the HTML also carries the desk's
  // server-drawn copy (F2), which is display: none on a phone until the shell drops it, so a node in the DOM
  // is not a row on screen.
  await page.addInitScript(() => {
    const w = window as unknown as { __brandSeen?: boolean; __frames?: number };
    w.__brandSeen = false;
    w.__frames = 0;
    const tick = () => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-testid="brand-card"]')) {
        if (el.getBoundingClientRect().height > 0) w.__brandSeen = true;
      }
      w.__frames = (w.__frames ?? 0) + 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.reload();
  await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { __frames?: number }).__frames)).toBeGreaterThan(5);
  expect(await page.evaluate(() => (window as unknown as { __brandSeen?: boolean }).__brandSeen)).toBe(false);
  await expect(brand(page)).toHaveCount(0);

  // Pending's menu doesn't offer it (the row lives on All); All's does, and it brings the row back.
  await page.goto('/?view=pending');
  await expect(page.getByTestId('view-switcher')).toBeVisible();
  await page.getByTestId('account-trigger').click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Show header' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await showAll(page);
  await page.getByTestId('account-trigger').click();
  await menu.getByRole('button', { name: 'Show header' }).click();
  await expect(menu).toHaveCount(0);
  await expect(brand(page)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('lp-brand-hidden'))).toBeNull();
  await page.reload();
  await expect(brand(page)).toBeVisible();
});

test.describe('brand row on a cold load', () => {
  // The logos and the first sync come from the network here (no service worker cache), slowed down.
  test.use({ serviceWorkers: 'block' });

  test('nothing moves: the row, the title and the live line keep their place while the logos and the rows load', async ({ page }) => {
    await page.route('**/logos/*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await page.route('**/api/sync*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.continue();
    });
    // The row and the view menu title, measured the moment they first appear.
    await page.addInitScript(() => {
      const w = window as unknown as { __firstSeen?: unknown };
      const observer = new MutationObserver(() => {
        const card = document.querySelector('[data-testid="brand-card"]');
        const title = document.querySelector('[data-testid="view-switcher"]');
        if (w.__firstSeen || !card || !title) return;
        w.__firstSeen = {
          card: card.getBoundingClientRect().toJSON(),
          title: title.getBoundingClientRect().toJSON(),
          logosLoaded: [...card.querySelectorAll('img')].map((img) => img.complete && img.naturalWidth > 0),
          skeleton: !!document.querySelector('[data-testid="list-skeleton"]'),
          live: document.querySelector('[data-testid="live-indicator"]')?.getAttribute('data-state') ?? null,
        };
        observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    });

    await page.goto('/');
    await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('live-text')).toHaveText('Updated just now');
    await expect
      .poll(() => brand(page).evaluate((el) => [...el.querySelectorAll('img')].every((img) => img.complete && img.naturalWidth > 0)))
      .toBe(true);
    const first = (await page.evaluate(() => (window as unknown as { __firstSeen?: unknown }).__firstSeen)) as {
      card: DOMRect;
      title: DOMRect;
      logosLoaded: boolean[];
      skeleton: boolean;
      live: string | null;
    };
    // It was measured before the logos, the rows and the first sync were there…
    expect(first.logosLoaded).toEqual([false, false]);
    expect(first.skeleton).toBe(true);
    expect(first.live).toBe('none');
    // …and nothing has moved since.
    const card = (await brand(page).boundingBox())!;
    const title = (await page.getByTestId('view-switcher').boundingBox())!;
    for (const [now, then] of [
      [card, first.card],
      [title, first.title],
    ] as const) {
      expect(now.y).toBeCloseTo(then.y, 0);
      expect(now.height).toBeCloseTo(then.height, 0);
      expect(now.x).toBeCloseTo(then.x, 0);
    }
  });
});

const live = (page: Page) => page.getByTestId('live-indicator');
const liveText = (page: Page) => page.getByTestId('live-text');

const connectionBanner = (page: Page) => page.getByTestId('connection-banner');
const refreshNow = (page: Page) => page.getByRole('button', { name: 'Refresh now', exact: true });
const isSync = (url: string) => new URL(url).pathname === '/api/sync';

test.describe('the line under the title (v2.2 afternoon: minutes, a banner for problems, Refresh now)', () => {
  // page.route() never sees a request a service worker passes on in WebKit, so this runs without one.
  test.use({ serviceWorkers: 'block' });

  test('"Updated just now" with no ticking; aborted syncs: the amber Reconnecting banner and "Last updated <time>"; Refresh recovers', async ({ page }) => {
    test.slow();
    await page.goto('/');
    await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 10_000 });
    await expect(live(page)).toHaveAttribute('data-state', 'healthy');
    await expect(liveText(page)).toHaveText('Updated just now');
    await expect(connectionBanner(page)).toHaveCount(0);
    // One line right under the title, lined up with it, before the list; tabular figures, a plain dot.
    const title = (await page.getByTestId('view-switcher').boundingBox())!;
    const line = (await live(page).boundingBox())!;
    expect(line.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
    expect(line.y).toBeLessThan(title.y + title.height + 8);
    await expect(live(page)).toHaveCSS('font-variant-numeric', 'tabular-nums');
    const dot = live(page).locator('[class*="liveDot"]');
    // Its dot lines up with the title's first letter. (F5 release: on All and My requests the line shares a row
    // with the "⇅" toggle, which holds the 16 px inset instead of the line, so the dot is measured, not the line.)
    expect(Math.abs((await dot.boundingBox())!.x - title.x)).toBeLessThan(2);
    await expect(dot).toHaveCSS('width', '7px');
    await expect(dot).toHaveCSS('box-shadow', 'none');
    const dotColour = () => dot.evaluate((el) => getComputedStyle(el).backgroundColor);
    const healthyDot = await dotColour();
    // Refresh now sits right after the words: a 32 px button centred on the line.
    const words = (await liveText(page).boundingBox())!;
    const button = (await refreshNow(page).boundingBox())!;
    expect(button.width).toBe(32);
    expect(button.height).toBe(32);
    expect(button.x - (words.x + words.width)).toBeLessThan(4);
    expect(Math.abs(button.y + button.height / 2 - (words.y + words.height / 2))).toBeLessThan(1.5);
    // The whole line as one sentence for screen readers.
    await expect(live(page)).toContainText('List updated just now.');
    // No ticking: across two syncs (every 6 s ± 1 s) nothing in the line changes at all.
    await live(page).evaluate((el) => {
      const w = window as unknown as { __lineChanges: number };
      w.__lineChanges = 0;
      new MutationObserver((records) => {
        w.__lineChanges += records.length;
      }).observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    for (let i = 0; i < 2; i += 1) await page.waitForResponse((r) => isSync(r.url()), { timeout: 10_000 });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __lineChanges: number }).__lineChanges)).toBe(0);

    // The log can't be reached while the phone reports a connection (every sync aborted): the amber banner,
    // and the line switches to the fixed clock time of the last good sync, with an amber dot.
    const before = Date.now();
    await page.route('**/api/sync*', (route) => route.abort());
    try {
      await expect(connectionBanner(page)).toHaveText('Reconnecting…', { timeout: 40_000 });
      await expect(connectionBanner(page)).toHaveAttribute('data-tone', 'amber');
      await expect(live(page)).toHaveAttribute('data-state', 'reconnecting');
      expect(await dotColour()).not.toBe(healthyDot);
      const shown = (await liveText(page).textContent()) ?? '';
      const clocks = [before - 8_000, before].map((t) => `Last updated ${formatCreatedTime(new Date(t).toISOString(), Date.now(), TZ)}`);
      expect(clocks).toContain(shown);
      await expect(live(page)).toContainText(`Reconnecting. List last updated at ${shown.replace('Last updated ', '')}.`);
      await expect(page.getByTestId('connection-indicator')).toHaveAttribute('data-state', 'reconnecting');
      await expect(page.getByTestId('live-announcement')).toHaveText('Reconnecting');
      // One state everywhere: never "Offline" while the phone reports a connection (the F1.1 review finding).
      await expect(page.getByText(/^Offline/)).toHaveCount(0);
    } finally {
      await page.unroute('**/api/sync*');
    }
    // Refresh now: the sync lands, the banner and the badge go, "Updated just now", "Back online" said once.
    await refreshNow(page).click();
    await expect(connectionBanner(page)).toHaveCount(0, { timeout: 15_000 });
    await expect(live(page)).toHaveAttribute('data-state', 'healthy');
    await expect(liveText(page)).toHaveText('Updated just now');
    await expect(page.getByTestId('connection-indicator')).toHaveCount(0);
    await expect(page.getByTestId('live-announcement')).toHaveText('Back online');

    // Pending and My requests have it too.
    for (const url of ['/?view=pending', '/?view=mine']) {
      await page.goto(url);
      await expect(liveText(page), url).toHaveText('Updated just now', { timeout: 10_000 });
      await expect(refreshNow(page), url).toBeVisible();
    }
  });

  test('Refresh now: exactly one immediate /api/sync, the glyph turns while it is in flight, repeat taps ignored, no reload', async ({ page }) => {
    await page.goto('/?view=pending');
    await expect(liveText(page)).toHaveText('Updated just now', { timeout: 10_000 });
    const button = refreshNow(page);
    // Right after a poll lands, the next one is 6 s ± 1 s away.
    await page.waitForResponse((r) => isSync(r.url()));
    await page.evaluate(() => {
      (window as unknown as { __noReload: boolean }).__noReload = true;
    });
    // Each sync is held 1.5 s so the turning glyph can be seen; every sync request from now on is counted.
    const syncs: number[] = [];
    page.on('request', (r) => {
      if (isSync(r.url())) syncs.push(Date.now());
    });
    const hold = async (route: Route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    };
    await page.route('**/api/sync*', hold);
    try {
      const tapped = Date.now();
      await button.click();
      await expect(button).toHaveAttribute('data-refreshing', '');
      await expect(button.locator('svg')).toHaveCSS('animation-name', /spin/);
      // Repeat taps while it is in flight do nothing.
      await button.click();
      await button.click();
      await expect(button).not.toHaveAttribute('data-refreshing', { timeout: 10_000 });
      expect(syncs).toHaveLength(1);
      expect(syncs[0]! - tapped).toBeLessThan(1_000);
    } finally {
      await page.unroute('**/api/sync*', hold);
    }
    await expect(liveText(page)).toHaveText('Updated just now');
    await expect(connectionBanner(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

    // Reduced motion: no turning, only dimmed while the sync is in flight.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/api/sync*', hold);
    try {
      await button.click();
      await expect(button).toHaveAttribute('data-refreshing', '');
      await expect(button.locator('svg')).toHaveCSS('animation-name', 'none');
      await expect(button).toHaveCSS('opacity', '0.45');
      await expect(button).not.toHaveAttribute('data-refreshing', { timeout: 10_000 });
      await expect(button).toHaveCSS('opacity', '1');
    } finally {
      await page.unroute('**/api/sync*', hold);
    }
  });
});

test('All rows: Created with AM/PM in the event timezone, Updated "—" until it changes, then a compact age', async ({ page }) => {
  const r = await createRequest(page);
  await page.goto('/');
  await expect(row(page, r.id)).toBeVisible({ timeout: 10_000 });
  const createdText = formatCreatedTime(r.createdAt, Date.now(), TZ);
  expect(createdText).toMatch(/^(\w{3} )?\d{1,2}:\d{2} (AM|PM)$/);
  await expect(cell(page, r.id, 'created')).toHaveText(createdText);
  await expect(cell(page, r.id, 'updated')).toHaveText('—');
  await expect(row(page, r.id)).toHaveAccessibleName(`${lp(r)}, ${r.name}, Waiting for check, created ${createdText}, not updated yet`);

  // Someone answers In medical: the row turns green and Updated reads "now" on the next poll.
  await setStatus(page, r, 'Found – Awaiting Reunion', 'answer');
  await expect(cell(page, r.id, 'updated')).toHaveText(/^(now|1m)$/, { timeout: 10_000 });
  await expect(cell(page, r.id, 'status')).toHaveText('In medical');
  await expect(cell(page, r.id, 'status')).toHaveAttribute('data-tone', 'green');
  await expect(row(page, r.id)).toHaveAccessibleName(
    new RegExp(`^${lp(r)}, ${r.name}, In medical, friend coming, created ${createdText}, updated (just now|1 minute ago)$`),
  );
});

test('All (option B): closed requests fold into "Archived N"; the fold opens in place, greyed, and stays open this session', async ({ page }) => {
  const openRow = await createRequest(page);
  const notIn = await notFound(page, await createRequest(page));
  await page.goto('/');
  await expect(row(page, openRow.id)).toBeVisible({ timeout: 10_000 });

  // Folded: the Not found in medical request is not listed; the fold sits after every open request.
  await expect(fold(page)).toBeVisible();
  await expect(fold(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(fold(page)).toHaveAccessibleName(/^Archived \d+ requests?$/);
  await expect(fold(page)).toHaveText(/^Archived\s*\d+$/);
  await expect(row(page, notIn.id)).toHaveCount(0);
  const order = await page.evaluate(
    ([openId]) => {
      const list = document.querySelector('[data-testid="request-list"]')!;
      const all = [...list.querySelectorAll('[data-request-id], [data-testid="closed-fold"]')];
      return { openAt: all.findIndex((el) => el.getAttribute('data-request-id') === openId), foldAt: all.findIndex((el) => el.matches('[data-testid="closed-fold"]')) };
    },
    [openRow.id],
  );
  expect(order.openAt).toBeGreaterThanOrEqual(0);
  expect(order.foldAt).toBeGreaterThan(order.openAt);

  // Open the fold: the closed rows below it (as many as it counts), greyed: glyph faded, text gray-11, the
  // row itself not faded (contrast, spec §7).
  await fold(page).click();
  await expect(fold(page)).toHaveAttribute('aria-expanded', 'true');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const label = document.querySelector('[data-testid="closed-fold"]')?.getAttribute('aria-label') ?? '';
        const shown = document.querySelectorAll('[data-testid="closed-rows"] [data-request-id]').length;
        return Number(/\d+/.exec(label)?.[0] ?? -1) === shown && shown > 0;
      }),
    )
    .toBe(true);
  await expect(page.getByTestId('closed-rows').locator(`[data-request-id="${notIn.id}"]`)).toBeVisible();
  await expect(row(page, notIn.id)).toHaveAttribute('data-closed', '');
  // iPhone 14 is under 430 px: "Not found in medical" reads "Not found" (the grey × says the rest, the row's
  // sentence says it in full), like "Waiting"; from 430 px the full label, on one line.
  await expect(cell(page, notIn.id, 'status')).toHaveText('Not found', { useInnerText: true });
  await expect(row(page, notIn.id)).toContainText(', Not found in medical, ');
  await page.setViewportSize({ width: 430, height: 932 });
  await expect(cell(page, notIn.id, 'status')).toHaveText('Not found in medical', { useInnerText: true });
  expect(await cell(page, notIn.id, 'status').evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(24);
  await page.setViewportSize({ width: 390, height: 664 });
  await expect(row(page, notIn.id)).toHaveCSS('opacity', '1');
  await expect(row(page, notIn.id).locator('svg[data-glyph="notInMedical"]')).toHaveCSS('opacity', '0.55');
  await expect(row(page, openRow.id)).not.toHaveAttribute('data-closed', '');

  // Remembered for the session (a reload keeps it open); tapping again folds it.
  await page.reload();
  await expect(fold(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, notIn.id)).toBeVisible();
  await fold(page).click();
  await expect(fold(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, notIn.id)).toHaveCount(0);

  // Search finds an archived request inline, greyed, with no fold (the fold stays shut behind it).
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('searchbox', { name: 'Search requests' }).fill(notIn.name);
  await expect(row(page, notIn.id)).toBeVisible();
  await expect(row(page, notIn.id)).toHaveAttribute('data-closed', '');
  await expect(fold(page)).toHaveCount(0);
});

/**
 * The log's columns at the current viewport: every name's width, every cell that is cut (other than names),
 * the grid's tracks, whether the page scrolls sideways.
 */
async function logLayout(page: Page) {
  return page.evaluate(() => {
    const log = document.querySelector<HTMLElement>('[data-testid="request-list"]')!;
    const cut = (el: Element) => el.scrollWidth > el.clientWidth + 0.5;
    const names = [...log.querySelectorAll<HTMLElement>('[data-col="name"]')];
    // A status label (the span after the glyph) may be cut, but only in a row whose name is at its floor.
    const labels = [...log.querySelectorAll<HTMLElement>('[data-col="status"] > span')].map((el) => ({
      text: el.innerText,
      cut: cut(el),
      name: el.closest('[data-request-id], [data-outbox-id]')!.querySelector<HTMLElement>('[data-col="name"]')!.getBoundingClientRect().width,
    }));
    const updated = [...log.querySelectorAll<HTMLElement>('[data-col="updated"]')].map((el) => el.getBoundingClientRect().width);
    const tracks = getComputedStyle(log).gridTemplateColumns.split(' ').map(parseFloat);
    return {
      nameWidths: names.map((el) => el.getBoundingClientRect().width),
      nameEllipsis: names[0] ? getComputedStyle(names[0]).textOverflow : '',
      cutCells: [...log.querySelectorAll<HTMLElement>('[data-col]')]
        .filter((el) => el.dataset.col !== 'name' && el.dataset.col !== 'match' && cut(el))
        .map((el) => `${el.dataset.col}: ${el.textContent}`),
      cutLabels: labels.filter((l) => l.cut),
      // The Updated column's own width (its track minus the row's 16 px right padding) and its widest value.
      updatedTrack: tracks.at(-1)! - 16,
      updatedWidest: Math.max(28, ...updated),
      pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

// Review fix (2026-11-06): on a 375 px iPhone the names were cut to 1–4 letters, and after midnight to 2:
// the "Updated" header sized its column, and once one row read "Fri 11:02 PM" Created widened for every row.
test('at 375 px after midnight the name keeps at least 80 px; numbers and times are never cut', async ({ page }) => {
  // A day later in this page: every request was logged on an earlier event day ("Fri 11:02 PM").
  const later = Date.now() + 86_400_000;
  await page.clock.setFixedTime(later);
  await page.setViewportSize({ width: 375, height: 812 });
  const r = await createRequest(page, { name: `${TAG} Kayla Alexandra Martinez-Rodriguez` });
  const notIn = await notFound(page, await createRequest(page));
  await page.goto('/');
  await expect(row(page, r.id)).toBeVisible({ timeout: 10_000 });
  const created = formatCreatedTime(r.createdAt, later, TZ);
  expect(created).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2} (AM|PM)$/);
  await expect(cell(page, r.id, 'created')).toHaveText(created);
  await expect(cell(page, r.id, 'status')).toHaveText('Waiting', { useInnerText: true });

  // Folded (the default view): every name has at least 80 px, nothing else is cut, and the "Updated" header
  // no longer widens its column past its values ("—", "2m", "1d").
  let layout = await logLayout(page);
  expect(Math.min(...layout.nameWidths)).toBeGreaterThanOrEqual(79.5);
  expect(layout.cutCells).toEqual([]);
  expect(layout.cutLabels).toEqual([]);
  expect(layout.updatedTrack).toBeLessThanOrEqual(layout.updatedWidest + 0.5);
  expect(layout.pageScrolls).toBe(false);
  expect(layout.nameEllipsis).toBe('ellipsis');
  expect(await cell(page, r.id, 'name').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

  // Archived rows open too (the widest statuses): the name still keeps its 80 px, the number and the times are
  // never cut, and a status label is cut only where the name is down to its floor.
  await fold(page).click();
  await expect(row(page, notIn.id)).toBeVisible();
  await expect(cell(page, notIn.id, 'created')).toHaveText(formatCreatedTime(notIn.createdAt, later, TZ));
  layout = await logLayout(page);
  expect(Math.min(...layout.nameWidths)).toBeGreaterThanOrEqual(79.5);
  expect(layout.cutCells).toEqual([]);
  for (const label of layout.cutLabels) expect(label.name, `"${label.text}" cut`).toBeLessThanOrEqual(80.5);
  expect(layout.pageScrolls).toBe(false);
  // Under 430 px the longest status reads "Not found" in the log (F2), whole.
  await expect(cell(page, notIn.id, 'status')).toHaveText('Not found', { useInnerText: true });

  // My requests: the progress line ends at "Not found in medical", on one line and never cut (F2).
  await page.goto('/?view=mine');
  const card = page.locator(`[data-testid="mine-card"]:has([data-request-id="${notIn.id}"])`);
  await expect(card).toBeVisible({ timeout: 10_000 });
  // (The card's status line says it too; this is the progress line's last step.)
  const last = card.locator('[data-step="cur"]').getByText('Not found in medical', { exact: true });
  await expect(last).toBeVisible();
  expect(await last.evaluate((el) => el.scrollWidth <= el.clientWidth + 0.5)).toBe(true);
  expect((await last.boundingBox())!.height).toBeLessThan(16);
});

// The deferred F2 fix (F3 + F4 release): on phones 400–429 px wide (Pixel 7a 412, iPhone 16 Pro 402, Plus 414 /
// 428) the full "Not found in medical" beside an earlier day's created time ("Fri 11:02 PM") was cut, so the
// short labels ("Waiting", "Not found") apply under 430 px, not 400. From 430 px the full labels, whole.
test('under 430 px the log uses the short labels beside an earlier day\'s time; from 430 px the full ones, never cut', async ({ page }) => {
  const later = Date.now() + 86_400_000;
  await page.clock.setFixedTime(later);
  await page.setViewportSize({ width: 400, height: 860 });
  const r = await createRequest(page, { name: `${TAG} Kayla Alexandra Martinez-Rodriguez` });
  const notIn = await notFound(page, await createRequest(page));
  await page.goto('/');
  await expect(row(page, r.id)).toBeVisible({ timeout: 10_000 });
  await expect(cell(page, r.id, 'created')).toHaveText(formatCreatedTime(r.createdAt, later, TZ));
  expect(formatCreatedTime(r.createdAt, later, TZ)).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2} (AM|PM)$/);
  await fold(page).click();
  await expect(row(page, notIn.id)).toBeVisible();
  const label = (id: string) => cell(page, id, 'status').locator(':scope > span').filter({ visible: true }).first();
  for (const [width, waiting, closed] of [
    [400, 'Waiting', 'Not found'],
    [412, 'Waiting', 'Not found'],
    [414, 'Waiting', 'Not found'],
    [429, 'Waiting', 'Not found'],
    [430, 'Waiting for check', 'Not found in medical'],
  ] as const) {
    await page.setViewportSize({ width, height: 860 });
    await expect(cell(page, r.id, 'status'), `${width} px`).toHaveText(waiting, { useInnerText: true });
    await expect(cell(page, notIn.id, 'status'), `${width} px`).toHaveText(closed, { useInnerText: true });
    // The row's sentence always says the whole status.
    await expect(row(page, notIn.id)).toContainText(', Not found in medical, ');
    for (const id of [r.id, notIn.id]) {
      expect(await label(id).evaluate((el) => el.scrollWidth <= el.clientWidth + 0.5), `${width} px: ${id} label cut`).toBe(true);
      expect((await cell(page, id, 'status').boundingBox())!.height, `${width} px: one line`).toBeLessThan(24);
    }
    const layout = await logLayout(page);
    expect(Math.min(...layout.nameWidths), `${width} px`).toBeGreaterThanOrEqual(79.5);
    expect(layout.cutCells, `${width} px`).toEqual([]);
    expect(layout.pageScrolls, `${width} px`).toBe(false);
  }
});

test('view switcher: Pending and My requests with counts, the same large title, the menu returns to All', async ({ page }) => {
  const r = await createRequest(page);
  await page.goto('/');
  await expect(row(page, r.id)).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('view-switcher').click();
  await expect(page.getByRole('menuitemradio', { name: /^All requests \d+$/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemradio', { name: /^My requests \d+$/ })).toBeVisible();
  await page.getByRole('menuitemradio', { name: /^Pending \d+$/ }).click();
  await expect(page).toHaveURL(/\?view=pending$/);
  await expect(checkCard(page, r.id)).toBeVisible();
  await expect(checkCard(page, r.id)).toContainText(`FA 3 · ${lp(r)}`);
  await expect(page.getByRole('heading', { level: 1, name: /^Pending \d+, change view$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to all requests' })).toHaveCount(0);

  await showAll(page);

  await page.getByTestId('view-switcher').click();
  await page.getByRole('menuitemradio', { name: /^My requests \d+$/ }).click();
  await expect(page).toHaveURL(/\?view=mine$/);
  await expect(page.getByRole('heading', { level: 1, name: /^My requests \d+, change view$/ })).toBeVisible();
  const card = page.locator(`[data-testid="mine-card"]:has([data-request-id="${r.id}"])`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Waiting for check');
  await expect(card).toContainText('Logged');
});

test('Alerts live in the avatar menu: it opens the Alerts sheet, whose New requests is the phone bell and server-side (F4)', async ({ page }) => {
  // Start from off on the server (the switch is server-side and this identity is reused across runs).
  const setNewRequests = async (on: boolean) =>
    expect((await page.request.post('/api/push/prefs', { headers: { origin: BASE }, data: { newRequests: on } })).status()).toBe(200);
  await setNewRequests(false);
  await page.goto('/');
  await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('account-trigger').click();
  const menu = page.getByRole('dialog', { name: 'Account' });
  await expect(menu.getByText('Export CSV')).toHaveCount(0);
  await menu.getByTestId('alerts-menu').click();
  const sheet = page.getByRole('dialog', { name: 'Alerts' });
  await expect(sheet).toBeVisible();
  const newRequests = sheet.getByRole('switch', { name: /New requests/ });
  await expect(newRequests).toHaveAttribute('aria-checked', 'false');
  await newRequests.click();
  await expect(newRequests).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lp-bell'))).toBe('1');
  // No "Alerts are on" intro on top of the sheet.
  await expect(page.getByRole('dialog', { name: 'Alerts are on' })).toHaveCount(0);
  await newRequests.click();
  await expect(newRequests).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lp-bell'))).toBeNull();
  // Server-side: a reload reads it back.
  await newRequests.click();
  await expect(newRequests).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('account-trigger').click();
  await page.getByRole('dialog', { name: 'Account' }).getByTestId('alerts-menu').click();
  await expect(page.getByRole('dialog', { name: 'Alerts' }).getByRole('switch', { name: /New requests/ })).toHaveAttribute('aria-checked', 'true');
  await setNewRequests(false);
});

test('Pending: In medical → Friend coming, Undo, then Reunited closes it (greyed under Archived in All)', async ({ page }) => {
  const r = await createRequest(page);
  await page.goto('/?view=pending');
  await expect(checkCard(page, r.id)).toBeVisible({ timeout: 10_000 });

  // In medical saves at once, then asks where they are (Skip saves nothing more).
  await checkCard(page, r.id).getByRole('button', { name: 'In medical', exact: true }).click();
  await expect(checkCard(page, r.id)).toHaveCount(0);
  const sheet = page.getByRole('dialog', { name: `${TAG} P${seq} is in medical` });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Skip' }).click();
  await expect(sheet).toHaveCount(0);
  // (v9.1) Friend coming is on the same page, under Waiting for check; its cards carry no friend line.
  await expect(comingCard(page, r.id)).toBeVisible();
  await expect(comingCard(page, r.id)).not.toContainText(`${TAG} Friend`);
  await expect(comingCard(page, r.id)).not.toContainText('from FA 3');

  await expect(page.getByText(`${lp(r)} · In medical`)).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(comingCard(page, r.id)).toHaveCount(0);
  await expect(checkCard(page, r.id)).toBeVisible();

  await checkCard(page, r.id).getByRole('button', { name: 'In medical', exact: true }).click();
  await sheet.getByRole('button', { name: 'Skip' }).click();
  await expect(comingCard(page, r.id)).toBeVisible();
  await comingCard(page, r.id).getByRole('button', { name: 'Reunited' }).click();
  await expect(comingCard(page, r.id)).toHaveCount(0);

  await showAll(page);
  // Closed: folded under "Archived N" until the fold is opened.
  await expect(row(page, r.id)).toHaveCount(0);
  await fold(page).click();
  await expect(cell(page, r.id, 'status')).toHaveText('Reunited');
  await expect(row(page, r.id)).toHaveAttribute('data-closed', '');
  // Closed rows are dimmed by their glyph and gray-11 text, never by row opacity (contrast, spec §7).
  await expect(row(page, r.id)).toHaveCSS('opacity', '1');
  await expect(row(page, r.id).locator('svg[data-glyph]')).toHaveCSS('opacity', '0.55');
});

test('Not found leaves Pending; ?status= shows a filter chip that clears to All', async ({ page }) => {
  const r = await createRequest(page);
  await page.goto('/?view=pending');
  await expect(checkCard(page, r.id)).toBeVisible({ timeout: 10_000 });
  // (v9.1) The first Not found holds it, in place with a "Not found yet" chip; the second closes it.
  await checkCard(page, r.id).getByTestId('not-found-answer').click();
  await expect(checkCard(page, r.id).getByTestId('hold-chip')).toHaveText('Not found yet');
  await checkCard(page, r.id).getByTestId('not-found-answer').click();
  await expect(checkCard(page, r.id)).toHaveCount(0);
  await expect.poll(async () => ((await (await page.request.get(`/api/requests/${r.id}`)).json()) as RequestSummary).status).toBe('Checked – Not Found');

  await page.goto(`/?status=${encodeURIComponent('Checked – Not Found')}`);
  const chip = page.getByTestId('status-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Not found in medical');
  await expect(row(page, r.id)).toBeVisible({ timeout: 10_000 });
  await expect(row(page, r.id)).toContainText('Not found in medical');
  // A filter shows its rows in one list: closed rows greyed in place, no fold.
  await expect(row(page, r.id)).toHaveAttribute('data-closed', '');
  await expect(fold(page)).toHaveCount(0);
  // Only Not found in medical rows are listed.
  const labels = await page.locator('[data-testid="request-list"] [data-request-id]').allTextContents();
  expect(labels.every((t) => t.includes('Not found in medical'))).toBe(true);

  await chip.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(chip).toHaveCount(0);
  // Back on the unfiltered log, Not found in medical is folded under Archived.
  await expect(fold(page)).toBeVisible();
  await expect(row(page, r.id)).toHaveCount(0);
});

test('search: name with highlight and count, LP number, Cancel returns', async ({ page }) => {
  const r = await createRequest(page);
  await page.goto('/?view=pending');
  await expect(checkCard(page, r.id)).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\?q=$/);
  const input = page.getByRole('searchbox', { name: 'Search requests' });
  await expect(input).toBeFocused();
  await input.fill(`${TAG} P${seq}`.toLowerCase());
  await expect(page.getByText('1 result', { exact: true })).toBeVisible();
  await expect(row(page, r.id).locator('mark')).toHaveText(`${TAG} P${seq}`);

  await input.fill(lp(r).toLowerCase());
  await expect(row(page, r.id)).toBeVisible();
  await expect(row(page, r.id).locator('mark')).toHaveText(String(r.caseNumber));

  await input.fill(`Synthetic ${TAG} jacket ${seq}`);
  await expect(row(page, r.id).locator('mark')).toHaveText(`Synthetic ${TAG} jacket ${seq}`);

  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(/\?view=pending$/);
});

test('front of house logs a request with a photo; the liaison sees it in Pending, answers In medical, and the logger is alerted', async ({
  browser,
  page,
}) => {
  test.slow();
  // Context B (this page): the medical liaison, already on Pending before the request exists.
  await page.goto('/?view=pending');
  await expect(page.getByTestId('view-switcher')).toBeVisible();
  await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('connection-indicator')).toHaveCount(0);

  // Context A: front of house (Dispatch) logs it through the form, with a photo.
  const foh = await newSignedInContext(browser, { staffName: `${TAG} Front`, team: 'GC/HX - Dispatch' }, { baseURL: BASE, viewport: { width: 390, height: 844 } });
  const a = await foh.newPage();
  const name = `${TAG} FOH Kayla`;
  // Assigned inside the poll below (a cast keeps TypeScript from narrowing it to null here).
  let id = null as string | null;
  try {
    await a.goto('/?new=1');
    await a.getByRole('button', { name: /^Reporting from/ }).click();
    const sheet = a.getByRole('dialog', { name: 'Reporting from' });
    await sheet.locator('label', { hasText: 'FA 4 – Oasis' }).click();
    await sheet.getByRole('button', { name: 'Done' }).click();
    await a.getByRole('group', { name: 'Missing person' }).getByLabel('Name', { exact: true }).fill(name);
    await a.getByLabel('Wearing').fill(`Synthetic ${TAG} silver jacket`);
    await a.locator('input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: syntheticPng() });
    await confirmCrop(a);
    await expect(a.getByRole('button', { name: /^1 photo/ })).toBeVisible();
    await a.getByTestId('request-form-submit').click();
    await expect(a.getByText(/^LP-\d{4,} saved$/)).toBeVisible();
    await expect(a.getByTestId('request-form')).toHaveCount(0);
    const savedAt = Date.now();

    // The row, and its photo (uploaded after the create).
    await expect
      .poll(async () => {
        const rows = (await syncRows<RequestSummary>(a.request)).filter((r) => r.name === name);
        id = rows[0]?.id ?? null;
        return rows.length;
      })
      .toBe(1);
    const created = (await (await a.request.get(`/api/requests/${id}`)).json()) as RequestDetail;
    const lpText = lp(created);

    // B sees it in Pending within 8 s of the save (one poll), and answers In medical.
    await expect(checkCard(page, id!)).toBeVisible({ timeout: Math.max(1_000, 8_000 - (Date.now() - savedAt)) });
    await expect(checkCard(page, id!)).toContainText(`FA 4 · ${lpText}`);
    await checkCard(page, id!).getByRole('button', { name: 'In medical', exact: true }).click();
    // Where medical has them: saved from the sheet, shown on the Friend coming card.
    const locationForm = page.getByTestId('location-form');
    await expect(locationForm).toBeVisible();
    await page.getByRole('textbox', { name: 'Location' }).fill('Chair 7');
    await locationForm.getByRole('button', { name: 'Save' }).click();
    await expect(comingCard(page, id!)).toBeVisible();
    await expect(comingCard(page, id!).getByTestId('location-chip')).toHaveAccessibleName('Chair 7, edit location');

    // A, back on the list, is alerted on its next poll: their own request moved to In medical.
    const toast = a.locator('.lp-toast').filter({ hasText: new RegExp(`${lpText} · .+ is in medical`) });
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(toast).toContainText(/LP-\d+ · .+ is in medical/);
    await expect(toast).toContainText('Bring the friend to Main Med');
    await expect.poll(async () => ((await (await a.request.get(`/api/requests/${id}`)).json()) as RequestDetail).photos.length).toBe(1);

    // Regression: B changes the answer (past the Undo window). A's sticky "is in medical" must not outlive
    // it: on A's next poll the new answer replaces it, so nobody walks the friend to Main Med for nothing.
    await page.waitForTimeout(6_500);
    const inMedical = (await (await page.request.get(`/api/requests/${id}`)).json()) as RequestDetail;
    const changed = await page.request.post(`/api/requests/${id}/status`, {
      headers: { origin: BASE },
      data: { status: 'Checked – Not Found', expectedVersion: inMedical.rowVersion, kind: 'change' },
    });
    expect(changed.ok(), `change answer → ${changed.status()}`).toBe(true);
    const notInMedical = a.locator('.lp-toast').filter({ hasText: new RegExp(`${lpText} · .+ — not found in medical`) });
    await expect(notInMedical).toBeVisible({ timeout: 15_000 });
    await expect(toast).toHaveCount(0);
    await expect(a.locator('.lp-toast').filter({ hasText: 'Bring the friend to Main Med' })).toHaveCount(0);
  } finally {
    if (id) {
      // Leave nothing open for the other specs.
      const row = (await (await a.request.get(`/api/requests/${id}`)).json()) as RequestDetail;
      const close =
        row.status === 'Added'
          ? a.request.post(`/api/requests/${id}/cancel`, { headers: { origin: BASE }, data: { expectedVersion: row.rowVersion } })
          : a.request.post(`/api/requests/${id}/status`, {
              headers: { origin: BASE },
              data: { status: 'Reunited – Closed', expectedVersion: row.rowVersion, kind: 'reunite' },
            });
      await close.catch(() => undefined);
    }
    await foh.close();
  }
});

test('a request logged elsewhere shows up within one poll (no live dot to tap)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 10_000 });
  const r = await createRequest(page);
  // Polls run every 6 s ± 1 s while the page is visible.
  await expect(row(page, r.id)).toBeVisible({ timeout: 9_000 });
});

test('offline: a badge on the avatar, the banner under the header, answers need a connection', async ({ page, context }) => {
  const r = await createRequest(page);
  await page.goto('/?view=pending');
  await expect(checkCard(page, r.id)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('connection-indicator')).toHaveCount(0);

  await expect(page.getByTestId('live-text')).toHaveText('Updated just now');

  const lastGood = Date.now();
  await context.setOffline(true);
  try {
    const badge = page.getByTestId('connection-indicator');
    await expect(badge).toHaveAttribute('data-state', 'offline');
    await expect(badge).toHaveAccessibleName('Offline');
    // The gray banner, and the line's fixed clock time with a gray dot; "Offline" announced once.
    await expect(connectionBanner(page)).toHaveText(/^Offline · \d+ waiting to send$/);
    await expect(connectionBanner(page)).toHaveAttribute('data-tone', 'gray');
    await expect(page.getByTestId('live-indicator')).toHaveAttribute('data-state', 'offline');
    const clocks = [lastGood - 8_000, lastGood].map((t) => `Last updated ${formatCreatedTime(new Date(t).toISOString(), Date.now(), TZ)}`);
    expect(clocks).toContain(await page.getByTestId('live-text').textContent());
    await expect(page.getByTestId('live-announcement')).toHaveText('Offline');
    await expect(page.getByText('Reconnecting…')).toHaveCount(0);
    // The badge sits on the avatar, inside the header row.
    const avatar = await page.getByTestId('account-trigger').boundingBox();
    const badgeBox = await badge.boundingBox();
    expect(avatar && badgeBox).toBeTruthy();
    expect(badgeBox!.x).toBeGreaterThan(avatar!.x);
    expect(badgeBox!.y).toBeGreaterThan(avatar!.y);
    // The shell may render its own copy (hidden before list views): only one is ever visible.
    const banner = page.getByText(/^Offline · \d+ waiting to send$/).filter({ visible: true });
    await expect(banner).toBeVisible();
    const title = await page.getByTestId('view-switcher').boundingBox();
    const bannerBox = await banner.boundingBox();
    const list = await page.getByTestId('request-list').boundingBox();
    expect(title && bannerBox && list).toBeTruthy();
    expect(bannerBox!.y).toBeGreaterThan(title!.y + title!.height - 1);
    expect(list!.y).toBeGreaterThan(bannerBox!.y);

    const answer = checkCard(page, r.id).getByRole('button', { name: 'In medical', exact: true });
    await expect(answer).toHaveAttribute('aria-disabled', 'true');
    // Each disabled answer is described by a hidden "Needs a connection"; the tap adds the visible toast.
    const reasons = page.getByText('Needs a connection', { exact: true });
    const before = await reasons.count();
    await answer.click({ force: true }); // aria-disabled: Playwright would wait for it to be enabled
    await expect(reasons).toHaveCount(before + 1);
    await expect(checkCard(page, r.id)).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
  // Back online: the badge and the banner go, the line reads "Updated just now", "Back online" is said once.
  await expect(page.getByTestId('connection-indicator')).toHaveCount(0, { timeout: 15_000 });
  await expect(connectionBanner(page)).toHaveCount(0);
  await expect(page.getByTestId('live-indicator')).toHaveAttribute('data-state', 'healthy', { timeout: 15_000 });
  await expect(page.getByTestId('live-text')).toHaveText('Updated just now');
  await expect(page.getByTestId('live-announcement')).toHaveText('Back online');
});
