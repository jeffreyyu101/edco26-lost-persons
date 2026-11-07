import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { RequestDetail, RequestSummary } from '../../lib/api-types';
import { formatCreatedTime } from '../../lib/format';
import { loadTestEnv, testBaseUrl } from '../../scripts/test-env.mjs';
import { syntheticPng } from './helpers/png';
import { newSignedInContext, signedInAs } from './helpers/session';
import { syncRows } from './helpers/sync';

// List views end to end (spec §8 List views, §9.4 "it appears in All and My requests", "a second context
// sees it in Pending … taps In medical", "Friend coming → Reunited", "undo", "search", "a tile filtering
// All"), with log option B and the header declutter (2026-11-06): the large title is the view menu, the
// number column, Created with AM/PM, Updated "—" until something changes, every closed request folded
// into "Archived N" (Brian, 2026-11-06), Alerts in the avatar menu, and no live dot unless the connection is
// down; and Jeffrey's brand card (2026-11-06 10:31) over All requests only (Pending v8, Brian 2026-11-06
// afternoon: Pending and My requests open with their large title; Pending is To check | Friend coming,
// tests/e2e/pending-v8.spec.ts has the rest). Runs against
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
  // iPhone 14 is 390 px wide: under 400 px "Waiting for check" reads "Waiting" (the blue ring says the rest,
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

/** The brand card as it is drawn now: box, background, radius, every text colour, the logos. */
async function brandLook(page: Page) {
  return brand(page).evaluate((el) => {
    const cs = getComputedStyle(el);
    const title = el.querySelector<HTMLElement>('[class*="title"]')!;
    return {
      box: el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number },
      background: cs.backgroundImage,
      border: cs.borderTopColor,
      radius: cs.borderTopLeftRadius,
      colors: [...el.querySelectorAll('p, p *')].map((n) => getComputedStyle(n).color),
      titleSize: Number.parseFloat(getComputedStyle(title).fontSize),
      titleHeight: title.getBoundingClientRect().height,
      edcFilter: getComputedStyle(el.querySelector('img[alt="EDC Orlando"]')!).filter,
      logos: [...el.querySelectorAll('img')].map((img) => ({ alt: img.alt, loaded: img.complete && img.naturalWidth > 0, height: img.getBoundingClientRect().height })),
      // The page around the card: the sticky bar's background (the theme's page colour).
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

test('brand card over All requests: logos, event, the big title, the credit; dark in both themes; not on Pending, My requests or Search', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 10_000 });
  const card = brand(page);
  await expect(card).toBeVisible();
  await expect(card.getByRole('img', { name: 'EDC Orlando' })).toBeVisible();
  await expect(card.getByRole('img', { name: 'Ground Control' })).toBeVisible();
  await expect(card.locator('[class*="kicker"]')).toHaveText('EVENT OPERATIONS · NOVEMBER 6–8, 2026', { useInnerText: true });
  await expect(card.locator('[class*="title"]')).toHaveText('Is my friend in medical?');
  await expect(card.locator('[class*="accent"]')).toHaveText('in medical?');
  await expect(card.locator('[class*="accent"]')).toHaveCSS('color', 'rgb(142, 240, 231)');
  await expect(card.locator('p[class*="credit"]')).toHaveText('Built by Jeffrey & Brian for Ground Control / Headliner Experience');
  // The card adds no heading: the view menu title is still the page's one h1.
  await expect(card.getByRole('heading')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

  // iPhone 14 (390 px): 12 px margin, 18 px radius, the title about 30 px on two lines, the logos at their
  // size, EDC made white.
  await expect.poll(async () => (await brandLook(page)).logos.every((l) => l.loaded)).toBe(true);
  const light = await brandLook(page);
  expect(light.box.x).toBe(12);
  expect(light.box.y).toBe(12);
  expect(light.box.width).toBe(390 - 24);
  expect(light.radius).toBe('18px');
  expect(light.titleSize).toBeGreaterThanOrEqual(29.5);
  expect(light.titleSize).toBeLessThanOrEqual(31.5);
  expect(light.titleHeight).toBeGreaterThan(light.titleSize * 2 - 1);
  expect(light.logos.map((l) => [l.alt, l.height])).toEqual([
    ['EDC Orlando', 34],
    ['Ground Control', 28],
  ]);
  expect(light.edcFilter).toContain('invert(1)');
  expect(light.background).toContain('linear-gradient');

  // The sticky bar follows the card: the view menu title, search and the avatar on one row under it.
  const title = (await page.getByTestId('view-switcher').boundingBox())!;
  const search = (await page.getByRole('button', { name: 'Search' }).boundingBox())!;
  const avatar = (await page.getByTestId('account-trigger').boundingBox())!;
  expect(title.y).toBeGreaterThan(light.box.y + light.box.height);
  expect(Math.abs(search.y + search.height / 2 - (avatar.y + avatar.height / 2))).toBeLessThan(2);
  expect(search.y).toBeLessThan(title.y + title.height);

  // Always dark: the same card in the dark and the light theme (only the page around it changes).
  await setTheme(page, 'dark');
  const dark = await brandLook(page);
  await setTheme(page, 'light');
  const lightAgain = await brandLook(page);
  expect(dark.page).not.toBe(lightAgain.page);
  for (const look of [dark, lightAgain]) {
    expect({ background: look.background, border: look.border, colors: look.colors, box: look.box }).toEqual({
      background: light.background,
      border: light.border,
      colors: light.colors,
      box: light.box,
    });
  }

  // It scrolls away with the page; the sticky bar stays at the top with the title, search and avatar.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('main')!.style.paddingBottom = '2400px';
    window.scrollTo(0, 700);
  });
  await expect.poll(async () => {
    const box = (await card.boundingBox())!;
    return box.y + box.height;
  }).toBeLessThan(0);
  const stuck = (await page.getByTestId('view-switcher').boundingBox())!;
  expect(stuck.y).toBeGreaterThanOrEqual(0);
  expect(stuck.y).toBeLessThan(60);
  await expect(page.getByRole('button', { name: 'Search' })).toBeInViewport();
  await expect(page.getByTestId('account-trigger')).toBeInViewport();

  // Pending and My requests open with just their large title (Pending v8), at the top of the page.
  for (const url of ['/?view=pending', '/?view=mine']) {
    await page.goto(url);
    await expect(page.getByTestId('view-switcher')).toBeVisible();
    await expect(brand(page), url).toHaveCount(0);
    expect((await page.getByTestId('view-switcher').boundingBox())!.y, url).toBeLessThan(40);
  }

  // Search keeps its own bar, with no card.
  await page.goto('/?q=');
  await expect(page.getByRole('searchbox', { name: 'Search requests' })).toBeVisible();
  await expect(brand(page)).toHaveCount(0);

  // Wider phone screens (640 px up to the desk's 768): the title grows and fits on one line.
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.goto('/');
  await expect(brand(page)).toBeVisible();
  const wide = await brandLook(page);
  expect(wide.titleSize).toBeGreaterThan(38);
  expect(wide.titleHeight).toBeLessThan(wide.titleSize * 1.5);
  expect(wide.box.width).toBe(760 - 24);

  // From 768 px the desk shell draws the brand (its own card over All requests, tests/e2e/desk-shell.spec.ts)
  // and the list's chrome (its rail / sidebar and top bar), so the list has no card of its own.
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto('/');
  await expect(page.getByTestId('desk-rail')).toBeVisible();
  await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-view] [data-testid="brand-card"]')).toHaveCount(0);
  await expect(brand(page)).toHaveCount(1);
  await expect(page.getByTestId('desk-brand').getByTestId('brand-card')).toBeVisible();
});

test.describe('brand card on a cold load', () => {
  // The logos and the first sync come from the network here (no service worker cache), slowed down.
  test.use({ serviceWorkers: 'block' });

  test('nothing moves: the card and the bar under it keep their place while the logos and the rows load', async ({ page }) => {
    await page.route('**/logos/*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await page.route('**/api/sync*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.continue();
    });
    // The card and the view menu title, measured the moment they first appear.
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
        };
        observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    });

    await page.goto('/');
    await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => brand(page).evaluate((el) => [...el.querySelectorAll('img')].every((img) => img.complete && img.naturalWidth > 0)))
      .toBe(true);
    const first = (await page.evaluate(() => (window as unknown as { __firstSeen?: unknown }).__firstSeen)) as {
      card: DOMRect;
      title: DOMRect;
      logosLoaded: boolean[];
      skeleton: boolean;
    };
    // It was measured before the logos and the rows were there…
    expect(first.logosLoaded).toEqual([false, false]);
    expect(first.skeleton).toBe(true);
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
  const notIn = await setStatus(page, await createRequest(page), 'Checked – Not Found', 'answer');
  await page.goto('/');
  await expect(row(page, openRow.id)).toBeVisible({ timeout: 10_000 });

  // Folded: the Not in medical request is not listed; the fold sits after every open request.
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
  await expect(cell(page, notIn.id, 'status')).toHaveText('Not in medical');
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
  const notIn = await setStatus(page, await createRequest(page), 'Checked – Not Found', 'answer');
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
  const tab = (name: RegExp) => page.getByRole('tab', { name });

  // In medical saves at once, then asks where they are (Skip saves nothing more).
  await checkCard(page, r.id).getByRole('button', { name: 'In medical', exact: true }).click();
  await expect(checkCard(page, r.id)).toHaveCount(0);
  const sheet = page.getByRole('dialog', { name: `${TAG} P${seq} is in medical` });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Skip' }).click();
  await expect(sheet).toHaveCount(0);
  await tab(/^Friend coming/).click();
  await expect(comingCard(page, r.id)).toBeVisible();
  await expect(comingCard(page, r.id)).toContainText(`${TAG} Friend · on the way`);
  await expect(comingCard(page, r.id)).not.toContainText('from FA 3');

  await expect(page.getByText(`${lp(r)} · In medical`)).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(comingCard(page, r.id)).toHaveCount(0);
  await tab(/^To check/).click();
  await expect(checkCard(page, r.id)).toBeVisible();

  await checkCard(page, r.id).getByRole('button', { name: 'In medical', exact: true }).click();
  await sheet.getByRole('button', { name: 'Skip' }).click();
  await tab(/^Friend coming/).click();
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

test('Not in medical leaves Pending; ?status= shows a filter chip that clears to All', async ({ page }) => {
  const r = await createRequest(page);
  await page.goto('/?view=pending');
  await expect(checkCard(page, r.id)).toBeVisible({ timeout: 10_000 });
  await checkCard(page, r.id).getByRole('button', { name: 'Not in medical' }).click();
  await expect(checkCard(page, r.id)).toHaveCount(0);

  await page.goto(`/?status=${encodeURIComponent('Checked – Not Found')}`);
  const chip = page.getByTestId('status-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Not in medical');
  await expect(row(page, r.id)).toBeVisible({ timeout: 10_000 });
  await expect(row(page, r.id)).toContainText('Not in medical');
  // A filter shows its rows in one list: closed rows greyed in place, no fold.
  await expect(row(page, r.id)).toHaveAttribute('data-closed', '');
  await expect(fold(page)).toHaveCount(0);
  // Only Not in medical rows are listed.
  const labels = await page.locator('[data-testid="request-list"] [data-request-id]').allTextContents();
  expect(labels.every((t) => t.includes('Not in medical'))).toBe(true);

  await chip.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(chip).toHaveCount(0);
  // Back on the unfiltered log, Not in medical is folded under Archived.
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
    await page.getByRole('tab', { name: /^Friend coming/ }).click();
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
    const notInMedical = a.locator('.lp-toast').filter({ hasText: new RegExp(`${lpText} · .+ — not in medical`) });
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

  await context.setOffline(true);
  try {
    const badge = page.getByTestId('connection-indicator');
    await expect(badge).toHaveAttribute('data-state', 'offline');
    await expect(badge).toHaveAccessibleName('Offline');
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
  // Live again: the badge goes away.
  await expect(page.getByTestId('connection-indicator')).toHaveCount(0, { timeout: 15_000 });
});
