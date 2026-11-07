import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ChangeResponse, CreateResponse, RequestDetail, RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { axeViolations, brandContrast, overlappingTargets, smallTargets } from './helpers/a11y';
import { signedInAs } from './helpers/session';

// Desk shell (components/desk; design/screens/desktop-log.html, desktop-new-tablet.html): the sidebar or
// icon rail, the top bar, the request docked beside the list (a sheet over it on iPad portrait), and the
// keyboard: "/" search, N new request, J/K and the arrows, Enter, Esc. All requests opens with Jeffrey's
// brand card above the top bar, and the sidebar / rail start with the compact logo lockup. The pane shows the
// profile with its actions under the status block, and the Undo snackbar stays clear of it. Under 768 px the
// phone app is unchanged. Synthetic rows only (TEST-shell-e2e-…), closed afterwards.

const BASE = testBaseUrl();
const STAFF = { staffName: 'TEST-shell Desk', team: 'GC/HX - Dispatch' };
const TAG = `TEST-shell-e2e-${Date.now().toString(36)}`;

test.use({ bypassCSP: true, serviceWorkers: 'block' });
signedInAs(STAFF);

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function api<T>(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

/** Each test's own tag, so a search never finds another test's rows (cancelled rows stay searchable). */
let tagSeq = 0;
const nextTag = () => `${TAG}-t${(tagSeq += 1)}x`;

async function createRequests(page: Page, n: number, tag: string = nextTag()): Promise<RequestSummary[]> {
  const rows: RequestSummary[] = [];
  for (let i = 1; i <= n; i += 1) {
    const { request } = await api<CreateResponse>(page.request, 'POST', '/api/requests', {
      clientMutationId: randomUUID(),
      reportingLocation: 'FA 3 – Kinetic',
      name: `${tag} P${i}`,
      age: 20 + i,
      gender: 'Female',
      clothing: `Synthetic ${tag} jacket ${i}`,
      lastSeen: 'kineticFIELD rail',
      contactName: `${tag} Friend`,
      contactPhone: '(407) 555-0142',
      contactRelationship: 'Friend',
    });
    created.push({ id: request.id, request: page.request });
    rows.push(request);
  }
  return rows;
}

/** Answer a request through the API (as another phone would). */
async function setStatus(page: Page, row: RequestSummary, status: string, kind: string): Promise<RequestSummary> {
  const { request } = await api<ChangeResponse>(page.request, 'POST', `/api/requests/${row.id}/status`, { status, expectedVersion: row.rowVersion, kind });
  return request;
}

test.afterEach(async () => {
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await api<RequestDetail>(request, 'GET', `/api/requests/${id}`);
      if (row.status === 'Added') {
        await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: BASE } });
      } else if (row.status === 'Found – Awaiting Reunion') {
        await request.fetch(`/api/requests/${id}/status`, {
          method: 'POST',
          data: { status: 'Reunited – Closed', expectedVersion: row.rowVersion, kind: 'reunite' },
          headers: { Origin: BASE },
        });
      }
    } catch {
      // Best effort.
    }
  }
});

const main = (page: Page) => page.locator('[data-desk-main]');
const row = (page: Page, id: string) => page.locator(`[data-desk-main] [data-request-id="${id}"]`).first();
const paramOf = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);

/** Request ids in the order the main column shows them (what J / K walk through). */
async function rowOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const ids: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-desk-main] [data-request-id]'))) {
      const id = el.dataset.requestId;
      if (id && !ids.includes(id) && el.getClientRects().length > 0) ids.push(id);
    }
    return ids;
  });
}

/** The docked pane's column: what is right of the main column (the pane plus its 1 px border). */
async function paneColumn(page: Page): Promise<number> {
  const box = (await main(page).boundingBox())!;
  return page.viewportSize()!.width - (box.x + box.width);
}

const activeRowId = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.requestId ?? null);

/** The desk's brand card (in the main column's brand slot, above the top bar). */
const deskBrand = (page: Page) => page.getByTestId('desk-brand').getByTestId('brand-card');

/** The card's title: font size and line box height (one line is under 1.5 × the size). */
async function brandTitle(card: Locator): Promise<{ size: number; height: number; right: number }> {
  return card.locator('[class*="title"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const text = document.createRange();
    text.selectNodeContents(el);
    return { size: Number.parseFloat(getComputedStyle(el).fontSize), height: r.height, right: text.getBoundingClientRect().right };
  });
}

const imagesLoaded = (el: Locator) => el.evaluate((n) => [...n.querySelectorAll('img')].every((img) => img.complete && img.naturalWidth > 0));

/** Where the Undo snackbar is, against the main column and the pane, and whether anything covers it. */
async function snackPlacement(page: Page) {
  const snack = page.locator('.lp-snack');
  await expect(snack.getByRole('button', { name: 'Undo' })).toBeVisible();
  // Past its 200 ms entrance.
  await page.waitForTimeout(300);
  const box = (await snack.boundingBox())!;
  const pane = (await page.getByTestId('desk-pane').boundingBox())!;
  const column = (await main(page).boundingBox())!;
  const uncovered = await snack.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const points = [
      [r.left + 4, r.top + r.height / 2],
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.right - 4, r.top + r.height / 2],
    ];
    return points.every(([x, y]) => el.contains(document.elementFromPoint(x!, y!)));
  });
  const vw = page.viewportSize()!;
  return { box, pane, column, uncovered, inView: box.x >= 0 && box.y >= 0 && box.x + box.width <= vw.width && box.y + box.height <= vw.height };
}

async function openSearchResults(page: Page, tag: string) {
  await page.goto(`/?q=${encodeURIComponent(tag)}`);
  await expect(main(page).locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
}

test.describe('desktop 1440 × 900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('sidebar, top bar and a request docked beside the list; J/K, Esc back to the row', async ({ page }) => {
    const tag = nextTag();
    const rows = await createRequests(page, 3, tag);
    await openSearchResults(page, tag);

    // Sidebar (not the rail), the top bar, and no phone chrome inside the main column.
    const sidebar = page.getByTestId('desk-sidebar');
    await expect(sidebar).toBeVisible();
    await expect(page.getByTestId('desk-rail')).toBeHidden();
    // The sidebar column is 232 px: the main column starts there.
    expect((await main(page).boundingBox())?.x).toBeCloseTo(232, 0);
    for (const name of [/^All requests \d+$/, /^Pending \d+$/, /^My requests \d+$/, /^Dashboard$/]) {
      await expect(sidebar.getByRole('link', { name })).toBeVisible();
    }
    await expect(sidebar.getByRole('switch', { name: 'Alerts' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Search requests' })).toHaveValue(tag);
    await expect(page.getByRole('button', { name: /^New request/ })).toHaveCount(1);
    // The Search view's own field (phone chrome) is hidden: the top bar's field drives it.
    await expect(page.locator('[data-desk-main] [data-view="search"] form[role="search"]')).toBeHidden();
    await expect(page.getByTestId('view-switcher')).toBeHidden();

    // Open the first result: it docks on the right (452 px), the list stays, the row is highlighted.
    const order = await rowOrder(page);
    const ours = rows.map((r) => r.id);
    expect(order.filter((id) => ours.includes(id)).length).toBe(3);
    const first = order[0]!;
    await row(page, first).click();
    await expect.poll(() => paramOf(page, 'r')).toBe(first);
    const pane = page.getByTestId('desk-pane');
    await expect(pane).toBeVisible();
    await expect(page.getByTestId('profile')).toBeVisible();
    expect(await paneColumn(page)).toBeCloseTo(452, 0);
    await expect(page.getByTestId('desk-pane-case')).toHaveText(/^LP-\d{4}$/);
    await expect(row(page, order[1]!)).toBeVisible();
    await expect(row(page, first)).not.toHaveCSS('box-shadow', 'none');
    // The profile's own top bar is the pane's now.
    await expect(page.getByTestId('profile-case')).toBeHidden();
    await expect(page.getByTestId('desk-prev')).toBeDisabled();

    // J / K and the arrows walk the main column's order; the open request follows.
    await page.keyboard.press('j');
    await expect.poll(() => paramOf(page, 'r')).toBe(order[1]);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => paramOf(page, 'r')).toBe(order[2]);
    await page.keyboard.press('k');
    await expect.poll(() => paramOf(page, 'r')).toBe(order[1]);
    await page.getByTestId('desk-prev').click();
    await expect.poll(() => paramOf(page, 'r')).toBe(first);

    // Esc closes it, back to the same list, and the focus returns to the row.
    await page.keyboard.press('Escape');
    await expect(pane).toHaveCount(0);
    expect(paramOf(page, 'r')).toBeNull();
    expect(paramOf(page, 'q')).toBe(tag);
    await expect.poll(() => activeRowId(page)).toBe(first);

    // With nothing open, J moves the selection (focus) and Enter opens it.
    await page.keyboard.press('j');
    await expect.poll(() => activeRowId(page)).toBe(order[1]);
    await page.keyboard.press('Enter');
    await expect.poll(() => paramOf(page, 'r')).toBe(order[1]);
    await page.getByTestId('desk-close').click();
    await expect(pane).toHaveCount(0);
    await expect.poll(() => activeRowId(page)).toBe(order[1]);
  });

  test('a row clicked or entered while a request is open replaces it: one Esc or × closes, focus on that row', async ({ page }) => {
    const tag = nextTag();
    await createRequests(page, 3, tag);
    await openSearchResults(page, tag);
    const order = await rowOrder(page);
    const [a, b, c] = order as [string, string, string];
    const pane = page.getByTestId('desk-pane');
    const entries = () => page.evaluate(() => window.history.length);
    const start = await entries();

    // Pointer: A, then B, then B again (already open: nothing new).
    await row(page, a).click();
    await expect.poll(() => paramOf(page, 'r')).toBe(a);
    await row(page, b).click();
    await expect.poll(() => paramOf(page, 'r')).toBe(b);
    await expect(pane).toHaveAttribute('data-request', b);
    await row(page, b).click();
    await page.keyboard.press('Escape');
    await expect(pane).toHaveCount(0);
    expect(paramOf(page, 'r')).toBeNull();
    expect(paramOf(page, 'q')).toBe(tag);
    await expect.poll(() => activeRowId(page)).toBe(b);

    // Keyboard: Enter on A opens it; Tab to C's row and Enter; × closes it in one, focus on C.
    await row(page, a).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => paramOf(page, 'r')).toBe(a);
    await row(page, c).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => paramOf(page, 'r')).toBe(c);
    await page.getByTestId('desk-close').click();
    await expect(pane).toHaveCount(0);
    expect(paramOf(page, 'r')).toBeNull();
    expect(paramOf(page, 'q')).toBe(tag);
    await expect.poll(() => activeRowId(page)).toBe(c);

    // Each pane session took one history entry, however many rows it showed.
    expect(await entries()).toBe(start + 1);
    expect(await page.evaluate(() => (window.history.state as { lpDepth?: number } | null)?.lpDepth ?? 0)).toBe(0);
  });

  test('J / K from the sidebar or the top bar move the focus to the row, so Enter opens that row', async ({ page }) => {
    const tag = nextTag();
    await createRequests(page, 2, tag);
    await page.goto('/?view=mine');
    await expect(main(page).locator('[data-request-id]').nth(1)).toBeVisible({ timeout: 15_000 });
    const ids = await rowOrder(page);

    // The focus on a sidebar link (where a click on it leaves it in Chromium).
    await page.getByTestId('desk-sidebar').getByRole('link', { name: /^My requests/ }).focus();
    await page.keyboard.press('j');
    await expect.poll(() => activeRowId(page)).toBe(ids[0]);
    await page.keyboard.press('j');
    await expect.poll(() => activeRowId(page)).toBe(ids[1]);

    // New request closed with Esc gives the focus back to its button; K then moves it to the row above,
    // and Enter opens that row, not New request again.
    await page.getByTestId('desk-new').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => paramOf(page, 'new')).toBe('1');
    await expect(page.getByTestId('request-form-submit')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(() => paramOf(page, 'new')).toBeNull();
    await expect(page.getByTestId('desk-new')).toBeFocused();
    await page.keyboard.press('k');
    await expect.poll(() => activeRowId(page)).toBe(ids[0]);
    await page.keyboard.press('Enter');
    await expect.poll(() => paramOf(page, 'r')).toBe(ids[0]);
    expect(paramOf(page, 'new')).toBeNull();
    await expect(page.getByTestId('request-form-submit')).toHaveCount(0);

    // Working in the open request keeps the focus there: J opens the next one, the pane's button stays focused.
    await page.getByTestId('desk-close').focus();
    await page.keyboard.press('j');
    await expect.poll(() => paramOf(page, 'r')).toBe(ids[1]);
    await expect(page.getByTestId('desk-close')).toBeFocused();
  });

  test('the dashboard: a request opened over another still closes in one Esc', async ({ page }) => {
    await createRequests(page, 2);
    await page.goto('/?dashboard=1');
    // F1's dashboard: the Recently updated region's rows (its heading is a "Show all requests" button).
    const recent = page.locator('[data-desk-main]').getByRole('region', { name: 'Recently updated' }).locator('button[data-request-id]');
    await expect(recent.nth(1)).toBeVisible({ timeout: 15_000 });
    await recent.nth(0).click();
    await expect.poll(() => paramOf(page, 'r')).not.toBeNull();
    const first = paramOf(page, 'r');
    await recent.nth(1).click();
    await expect.poll(() => paramOf(page, 'r')).not.toBe(first);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('desk-pane')).toHaveCount(0);
    await expect.poll(() => paramOf(page, 'r')).toBeNull();
    expect(paramOf(page, 'dashboard')).toBe('1');
  });

  test('"/" searches, N opens New request, keys never fire while typing; the sidebar switches views', async ({ page }) => {
    const tag = nextTag();
    await createRequests(page, 1, tag);
    await page.goto('/');
    await expect(main(page).locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { level: 1, name: /^All requests \d+$/ })).toBeVisible();
    await expect(page.getByTestId('desk-sidebar').getByRole('link', { name: /^All requests/ })).toHaveAttribute('aria-current', 'page');
    // The list's phone chrome (its title row, view switcher, floating New request) is the shell's here.
    await expect(page.getByTestId('view-switcher')).toBeHidden();
    await expect(page.getByTestId('live-dot')).toBeHidden();

    // "/" focuses the field; typing opens Search; N and J are just letters there.
    await page.locator('body').press('/');
    const field = page.getByRole('searchbox', { name: 'Search requests' });
    await expect(field).toBeFocused();
    await page.keyboard.type(tag.slice(0, -1));
    await page.keyboard.type('n');
    await expect(field).toHaveValue(`${tag.slice(0, -1)}n`);
    expect(paramOf(page, 'new')).toBeNull();
    await field.fill(tag);
    await expect.poll(() => paramOf(page, 'q')).toBe(tag);
    await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
    await expect(main(page).locator('[data-request-id]')).toHaveCount(1);
    // Esc clears, then leaves search.
    await field.press('Escape');
    await expect(field).toHaveValue('');
    await field.press('Escape');
    await expect.poll(() => paramOf(page, 'q')).toBeNull();
    await expect(page.getByRole('heading', { level: 1, name: /^All requests/ })).toBeVisible();

    // N opens New request over the desk; the sidebar is inert behind it; Cmd+N is left to the browser.
    await page.locator('body').press('Meta+n').catch(() => undefined);
    expect(paramOf(page, 'new')).toBeNull();
    await page.locator('body').press('n');
    await expect.poll(() => paramOf(page, 'new')).toBe('1');
    await expect(page.getByTestId('request-form-submit')).toBeVisible();
    // Nothing behind the form can be reached: inert while the form covers the desk in place, hidden from
    // assistive tech (and outside the focus trap) under a form that opens as a dialog.
    await expect.poll(() => page.getByTestId('desk-sidebar').evaluate((el) => !!el.closest('[inert], [aria-hidden="true"]'))).toBe(true);
    await page.goBack();
    await expect.poll(() => paramOf(page, 'new')).toBeNull();

    // Closing the form gives the focus back to where it was before it opened.
    await page.getByTestId('desk-new').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => paramOf(page, 'new')).toBe('1');
    await expect(page.getByTestId('request-form-submit')).toBeVisible();
    await page.goBack();
    await expect.poll(() => paramOf(page, 'new')).toBeNull();
    await expect(page.getByTestId('desk-new')).toBeFocused();

    // The sidebar switches views in place.
    await page.getByTestId('desk-sidebar').getByRole('link', { name: /^Pending/ }).click();
    await expect.poll(() => paramOf(page, 'view')).toBe('pending');
    await expect(page.getByRole('heading', { level: 1, name: /^Pending \d+$/ })).toBeVisible();
    await expect(page.getByTestId('desk-sidebar').getByRole('link', { name: /^Pending/ })).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('desk-sidebar').getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

    // Alerts (the phone's bell) and the account menu (the phone's avatar menu).
    const alerts = page.getByTestId('desk-sidebar').getByRole('switch', { name: 'Alerts' });
    await expect(alerts).toHaveAttribute('aria-checked', 'false');
    await alerts.click();
    await expect(alerts).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('dialog', { name: 'Alerts are on' })).toBeVisible();
    await page.getByRole('button', { name: 'Got it' }).click();
    await page.getByTestId('desk-sidebar').getByTestId('account-trigger').click();
    const menu = page.getByRole('dialog', { name: 'Account' });
    await expect(menu).toBeVisible();
    // F1's avatar menu: Alerts moved in from the bell, Export CSV is gone (Jeffrey exports from Supabase).
    for (const item of ['Alerts', 'Dashboard', 'Sign out']) await expect(menu.getByText(item, { exact: true })).toBeVisible();
    await expect(menu.getByText('Export CSV', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('All requests opens with the brand row above the top bar; it scrolls away, the bar stays; no row on the other views; the logo lockup', async ({ page }) => {
    const [one] = await createRequests(page, 1);
    await page.goto('/');
    await expect(main(page).locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
    const card = deskBrand(page);
    await expect(card).toBeVisible();
    // One row: the desk's (the list's own is phone only).
    await expect(page.getByTestId('brand-card')).toHaveCount(1);
    await expect(card.getByRole('img', { name: 'EDC Orlando' })).toBeVisible();
    await expect(card.getByRole('img', { name: 'Ground Control' })).toBeVisible();
    // F1.1's compact row (design/screens/live-indicator.html, the Desktop frame): the title, the long dates
    // beside it, the X; no kicker, no credit line, no rings.
    await expect(card.locator('p[class*="title"]')).toHaveText('Is my friend in medical?');
    await expect(card.locator('[class*="datesLong"]')).toHaveText('NOVEMBER 6–8, 2026', { useInnerText: true });
    await expect(card.locator('[class*="datesShort"]')).toBeHidden();
    await expect(card).not.toContainText(/event op/i);
    await expect(card).not.toContainText('Built by');
    await expect(card.locator('[class*="orbit"]')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Hide header' })).toBeVisible();
    // No heading of its own: the top bar's title is the page's one h1.
    await expect(card.getByRole('heading')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

    // The top of the main column, lined up with the top bar's title (24 px in), 20 px from the right; one row
    // about 60 px tall, the title one line of 19 px, the dates beside it.
    const column = (await main(page).boundingBox())!;
    const box = (await card.boundingBox())!;
    expect(box.x).toBeCloseTo(column.x + 24, 0);
    expect(box.width).toBeCloseTo(column.width - 44, 0);
    expect(box.y).toBeCloseTo(14, 0);
    expect(box.height).toBeLessThanOrEqual(64);
    const title = await brandTitle(card);
    expect(title.size).toBe(19);
    expect(title.height).toBeLessThan(title.size * 1.5);
    const dates = (await card.locator('[class*="datesLong"]').boundingBox())!;
    expect(dates.x).toBeGreaterThan(title.right);
    const heading = (await page.getByTestId('desk-topbar').getByRole('heading', { level: 1 }).boundingBox())!;
    expect(Math.abs(box.x - heading.x)).toBeLessThanOrEqual(1);
    const bar = page.getByTestId('desk-topbar');
    expect((await bar.boundingBox())!.y).toBeGreaterThanOrEqual(box.y + box.height);
    // Every text on it at 4.5:1 or more against every pixel behind it, at this size too.
    await expect.poll(() => imagesLoaded(card)).toBe(true);
    expect(await brandContrast(page, card)).toEqual([]);

    // It scrolls away; the top bar stays at the top with search and New request. (With only a few open rows the
    // table's min-height lets the page scroll exactly the row's height and margin: its bottom edge then sits
    // at 0, which is gone too.)
    await page.evaluate(() => window.scrollTo(0, 600));
    await expect.poll(async () => {
      const b = (await card.boundingBox())!;
      return b.y + b.height;
    }).toBeLessThanOrEqual(0);
    expect((await bar.boundingBox())!.y).toBeCloseTo(0, 0);
    await expect(page.getByRole('searchbox', { name: 'Search requests' })).toBeInViewport();
    await expect(page.getByTestId('desk-new')).toBeInViewport();

    // The sidebar starts with the compact lockup: both logos on the brand's dark gradient, the live dot on its
    // corner; it is the sync button, named by the live state.
    const lockup = page.getByTestId('desk-sidebar').getByTestId('desk-live');
    await expect(lockup).toHaveAccessibleName(/^(Live\. Tap to sync now|Syncing)$/);
    await expect(lockup.locator('img')).toHaveCount(2);
    await expect.poll(() => imagesLoaded(lockup)).toBe(true);
    const lock = (await lockup.boundingBox())!;
    expect(lock.height).toBe(44);
    expect(lock.width).toBeGreaterThan(180);
    expect(lock.y).toBeLessThan(20);
    expect(await lockup.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('linear-gradient');

    // A request open beside the list: the row stays at the top of the narrower column, title one line.
    await page.goto(`/?r=${one!.id}`);
    await expect(page.getByTestId('desk-pane')).toBeVisible({ timeout: 15_000 });
    await expect(card).toBeVisible();
    const docked = await brandTitle(card);
    expect(docked.height).toBeLessThan(docked.size * 1.5);
    expect(docked.right).toBeLessThanOrEqual((await card.getByRole('button', { name: 'Hide header' }).boundingBox())!.x);
    expect((await card.boundingBox())!.x + (await card.boundingBox())!.width).toBeLessThanOrEqual((await page.getByTestId('desk-pane').boundingBox())!.x);

    // Pending, My requests (Brian, 2026-11-06), Search and the dashboard have no card: the top bar is at the top.
    for (const [url, heading] of [
      ['/?view=pending', /^Pending/],
      ['/?view=mine', /^My requests/],
      ['/?q=TEST-shell', /^Search$/],
      ['/?dashboard=1', /^Dashboard$/],
    ] as const) {
      await page.goto(url);
      await expect(page.getByRole('heading', { level: 1, name: heading }), url).toBeVisible();
      await expect(page.getByTestId('brand-card'), url).toHaveCount(0);
      expect((await bar.boundingBox())!.y, url).toBeCloseTo(0, 0);
    }
  });

  test('the brand row\'s X hides it on this device: never drawn after a reload (not even before hydration), Show header brings it back', async ({ page }) => {
    await createRequests(page, 1);
    await page.goto('/');
    await expect(main(page).locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
    const card = deskBrand(page);
    await expect(card).toBeVisible();
    const bar = page.getByTestId('desk-topbar');
    const barBefore = (await bar.boundingBox())!;
    // While it shows, the sidebar's account menu has no Show header.
    const menu = page.getByRole('dialog', { name: 'Account' });
    await page.getByTestId('desk-sidebar').getByTestId('account-trigger').click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Show header' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // The X (a keyboard press): the row goes, the top bar moves to the top, focus lands on the top bar's title.
    await card.getByRole('button', { name: 'Hide header' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('brand-card')).toHaveCount(0);
    await expect(page.getByTestId('desk-brand')).toHaveCount(0);
    expect((await bar.boundingBox())!.y).toBeLessThan(barBefore.y);
    expect((await bar.boundingBox())!.y).toBeCloseTo(0, 0);
    expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="desk-topbar"]') !== null)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('lp-brand-hidden'))).toBe('1');
    await expect(page.locator('html')).toHaveAttribute('data-brand-hidden', '');

    // After a reload the server still draws the row (it can't know), but it never shows: the pre-paint script
    // keeps it display: none until the shell drops it. Checked before every frame is painted (a rAF callback
    // runs only once the page can render, so its stylesheets are in).
    await page.addInitScript(() => {
      const w = window as unknown as { __brandShown?: boolean; __frames?: number };
      w.__brandShown = false;
      w.__frames = 0;
      const tick = () => {
        const el = document.querySelector<HTMLElement>('[data-testid="desk-brand"]');
        if (el && el.getBoundingClientRect().height > 0) w.__brandShown = true;
        w.__frames = (w.__frames ?? 0) + 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.reload();
    await expect(main(page).locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __frames?: number }).__frames)).toBeGreaterThan(5);
    expect(await page.evaluate(() => (window as unknown as { __brandShown?: boolean }).__brandShown)).toBe(false);
    await expect(page.getByTestId('brand-card')).toHaveCount(0);
    expect((await bar.boundingBox())!.y).toBeCloseTo(0, 0);

    // Pending's menu doesn't offer it (the row lives on All); All's does, in the sidebar and in the rail.
    await page.goto('/?view=pending');
    await expect(page.getByRole('heading', { level: 1, name: /^Pending/ })).toBeVisible();
    await page.getByTestId('desk-sidebar').getByTestId('account-trigger').click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Show header' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.goto('/');
    await expect(main(page).locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.getByTestId('desk-sidebar').getByTestId('account-trigger').click();
    await menu.getByRole('button', { name: 'Show header' }).click();
    await expect(menu).toHaveCount(0);
    await expect(card).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('lp-brand-hidden'))).toBeNull();
    expect(await page.locator('html').getAttribute('data-brand-hidden')).toBeNull();
    await page.reload();
    await expect(card).toBeVisible({ timeout: 15_000 });
  });

  test('the live line sits next to the top bar\'s title on every view; Refresh now syncs once; a failing sync: the banner, "Last updated", the amber lockup dot', async ({ page }) => {
    test.slow();
    await createRequests(page, 1);
    await page.goto('/');
    await expect(main(page).locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
    const bar = page.getByTestId('desk-topbar');
    const line = bar.getByTestId('live-indicator');
    // One line on the page: the top bar's (the lists' own is phone chrome).
    await expect(page.getByTestId('live-indicator')).toHaveCount(1);
    await expect(line).toHaveAttribute('data-state', 'healthy');
    await expect(line.getByTestId('live-text')).toHaveText('Updated just now');
    await expect(line).toContainText('List updated just now.');
    // Right after the title and its count, on its line, before search and New request; a plain dot.
    const title = (await bar.getByRole('heading', { level: 1 }).boundingBox())!;
    const box = (await line.boundingBox())!;
    expect(box.x).toBeGreaterThan(title.x + title.width - 1);
    expect(box.x).toBeLessThan(title.x + title.width + 24);
    expect(Math.abs(box.y + box.height / 2 - (title.y + title.height / 2))).toBeLessThan(2);
    expect(box.x + box.width).toBeLessThanOrEqual((await bar.getByRole('search').boundingBox())!.x);
    await expect(line.locator('[class*="liveDot"]')).toHaveCSS('box-shadow', 'none');
    for (const [url, heading] of [
      ['/?view=pending', /^Pending/],
      ['/?view=mine', /^My requests/],
      ['/?q=TEST-shell', /^Search$/],
    ] as const) {
      await page.goto(url);
      await expect(bar.getByRole('heading', { level: 1, name: heading }), url).toBeVisible();
      await expect(line.getByTestId('live-text'), url).toHaveText('Updated just now', { timeout: 15_000 });
      await expect(page.getByTestId('live-indicator'), url).toHaveCount(1);
    }

    // Refresh now: exactly one immediate /api/sync, never a reload.
    await page.goto('/');
    await expect(line.getByTestId('live-text')).toHaveText('Updated just now', { timeout: 15_000 });
    await page.waitForResponse((r) => new URL(r.url()).pathname === '/api/sync');
    await page.evaluate(() => {
      (window as unknown as { __noReload: boolean }).__noReload = true;
    });
    const syncs: number[] = [];
    const count = (r: { url(): string }) => {
      if (new URL(r.url()).pathname === '/api/sync') syncs.push(Date.now());
    };
    page.on('request', count);
    const refresh = line.getByRole('button', { name: 'Refresh now', exact: true });
    const tapped = Date.now();
    await refresh.click();
    await expect(refresh).not.toHaveAttribute('data-refreshing', { timeout: 10_000 });
    page.off('request', count);
    expect(syncs).toHaveLength(1);
    expect(syncs[0]! - tapped).toBeLessThan(1_000);
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

    // Every sync aborted while the device reports a connection: Reconnecting in the column, the line's clock
    // time beside the title, and the lockup's dot amber (one state everywhere).
    const lockup = page.getByTestId('desk-sidebar').getByTestId('desk-live');
    await page.route('**/api/sync*', (route) => route.abort());
    try {
      for (let i = 0; i < 4 && (await page.getByTestId('connection-banner').count()) === 0; i += 1) {
        await refresh.click();
        await expect(refresh).not.toHaveAttribute('data-refreshing', { timeout: 15_000 });
      }
      await expect(main(page).getByTestId('connection-banner')).toHaveText('Reconnecting…', { timeout: 40_000 });
      await expect(line).toHaveAttribute('data-state', 'reconnecting');
      await expect(line.getByTestId('live-text')).toHaveText(/^Last updated \d{1,2}:\d{2} (AM|PM)$/);
      await expect(lockup).toHaveAccessibleName('Reconnecting. Tap to try again');
      await expect(lockup.locator('[data-state]')).toHaveAttribute('data-state', 'off');
      await expect(page.getByText(/^Offline/)).toHaveCount(0);
    } finally {
      await page.unroute('**/api/sync*');
    }
    await refresh.click();
    await expect(page.getByTestId('connection-banner')).toHaveCount(0, { timeout: 15_000 });
    await expect(line.getByTestId('live-text')).toHaveText('Updated just now');
    await expect(lockup).toHaveAccessibleName('Live. Tap to sync now');
  });

  test('the pane: the profile with its actions under the status (Change answer menu, Reunited), ⋯, previous / next, close; Undo stays in the list column', async ({ page }) => {
    const [row] = await createRequests(page, 1);
    await setStatus(page, row!, 'Found – Awaiting Reunion', 'answer');
    await page.goto(`/?r=${row!.id}`);
    const pane = page.getByTestId('desk-pane');
    await expect(pane.getByTestId('status-block')).toContainText('In medical', { timeout: 15_000 });
    for (const id of ['desk-prev', 'desk-next', 'desk-more', 'desk-close']) await expect(page.getByTestId(id)).toBeVisible();

    // Right under the status block and before the details (desktop-log.html): two equal buttons.
    const actions = pane.getByTestId('profile-actions');
    const status = (await pane.getByTestId('status-block').boundingBox())!;
    const bar = (await actions.boundingBox())!;
    expect(bar.y).toBeGreaterThanOrEqual(status.y + status.height);
    expect(bar.y + bar.height).toBeLessThan((await pane.getByTestId('person-details').boundingBox())!.y);
    const change = actions.getByRole('button', { name: 'Change answer' });
    const reunited = actions.getByRole('button', { name: 'Reunited' });
    const cb = (await change.boundingBox())!;
    const rb = (await reunited.boundingBox())!;
    expect(cb.y).toBe(rb.y);
    expect(Math.abs(cb.width - rb.width)).toBeLessThanOrEqual(1);

    // Change answer: the other answer and Back to Waiting for check, each with its glyph, opening downwards.
    await change.click();
    const menu = page.getByTestId('change-answer-menu');
    await expect(menu.getByRole('menuitem')).toHaveText(['Not found', 'Back to Waiting for check']);
    expect((await menu.boundingBox())!.y).toBeGreaterThanOrEqual(cb.y + cb.height - 1);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(pane).toBeVisible();

    // ⋯: Edit details and Mark discharged (In medical).
    await page.getByTestId('desk-more').click();
    await expect(page.getByRole('menuitem', { name: 'Edit details' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Mark discharged' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: 'Edit details' })).toHaveCount(0);

    // Reunited: the Undo bar sits in the list column, clear of the sidebar and the pane, covered by nothing.
    await reunited.click();
    await expect(pane.getByTestId('status-block')).toContainText('Reunited');
    const at = await snackPlacement(page);
    expect(at.inView).toBe(true);
    expect(at.uncovered).toBe(true);
    expect(at.box.x).toBeGreaterThanOrEqual(at.column.x);
    expect(at.box.x + at.box.width).toBeLessThanOrEqual(at.pane.x);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(pane.getByTestId('status-block')).toContainText('In medical');
    await expect(actions.getByRole('button', { name: 'Reunited' })).toBeVisible();
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`passes axe with a request open (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('lp-theme', t);
        } catch {
          // ignore
        }
      }, theme);
      const [one] = await createRequests(page, 1);
      await page.goto(`/?r=${one!.id}`);
      await expect(page.getByTestId('desk-pane')).toBeVisible({ timeout: 15_000 });
      await expect(row(page, one!.id)).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(400);
      expect(await axeViolations(page)).toEqual([]);
    });
  }
});

test.describe('laptop 1024 × 768', () => {
  test.use({ viewport: { width: 1024, height: 768 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('the brand row fits its column: the title stays one line when a request docks beside the list; the rail lockup', async ({ page }) => {
    const [one] = await createRequests(page, 1);
    await page.goto('/');
    await expect(main(page).locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
    const card = deskBrand(page);
    const wide = await brandTitle(card);
    expect(wide.size).toBe(19);
    expect(wide.height).toBeLessThan(wide.size * 1.5);
    await expect(card.locator('[class*="datesLong"]')).toBeVisible();

    // The rail's lockup: a 44 px square with both logos.
    const lockup = page.getByTestId('desk-rail').getByTestId('desk-live');
    const lock = (await lockup.boundingBox())!;
    expect([lock.width, lock.height]).toEqual([44, 44]);
    await expect.poll(() => imagesLoaded(lockup)).toBe(true);

    // A 544 px column next to the 420 px pane: the short dates go back under the title, which stays one line,
    // a little smaller, clear of the X.
    await page.goto(`/?r=${one!.id}`);
    await expect(page.getByTestId('desk-pane')).toBeVisible({ timeout: 15_000 });
    const docked = await brandTitle(card);
    expect(docked.size).toBeGreaterThanOrEqual(16);
    expect(docked.size).toBeLessThanOrEqual(wide.size);
    expect(docked.height).toBeLessThan(docked.size * 1.5);
    await expect(card.locator('[class*="datesShort"]')).toHaveText('NOV 6–8', { useInnerText: true });
    await expect(card.locator('[class*="datesLong"]')).toBeHidden();
    const box = (await card.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(64);
    expect(docked.right).toBeLessThanOrEqual((await card.getByRole('button', { name: 'Hide header' }).boundingBox())!.x);
    expect(await brandContrast(page, card)).toEqual([]);
    expect(box.x + box.width).toBeLessThanOrEqual((await page.getByTestId('desk-pane').boundingBox())!.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });
});

test.describe('iPad landscape 1180 × 820 (touch)', () => {
  test.use({ viewport: { width: 1180, height: 820 }, isMobile: false, hasTouch: true, deviceScaleFactor: 1 });

  test('icon rail; the request docks at 420 px; 44 px targets that never overlap', async ({ page }) => {
    const [one] = await createRequests(page, 1);
    await page.goto('/');
    await expect(main(page).locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
    const rail = page.getByTestId('desk-rail');
    await expect(rail).toBeVisible();
    await expect(page.getByTestId('desk-sidebar')).toBeHidden();
    expect((await main(page).boundingBox())?.x).toBeCloseTo(60, 0);
    await expect(rail.getByRole('link', { name: /^Pending( \d+)?$/ })).toBeVisible();

    await page.goto(`/?r=${one!.id}`);
    const pane = page.getByTestId('desk-pane');
    await expect(pane).toBeVisible({ timeout: 15_000 });
    expect(await paneColumn(page)).toBeCloseTo(420, 0);
    // A narrow main column: the search icon and "New" (desktop-new-tablet.html, iPad landscape).
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Search requests' })).toBeHidden();
    await expect.poll(async () => (await page.getByTestId('desk-new').innerText()).trim()).toBe('New');
    await expect(page.getByTestId('desk-new')).toHaveAccessibleName('New');

    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    test.skip(!coarse, 'this browser does not report a coarse pointer for touch emulation');
    for (const scope of ['[data-testid="desk-rail"]', '[data-testid="desk-topbar"]', '[data-testid="desk-pane"] header', '[data-testid="desk-pane"] [data-testid="profile-actions"]']) {
      expect(await smallTargets(page, scope), scope).toEqual([]);
      expect(await overlappingTargets(page, scope), scope).toEqual([]);
    }
  });
});

test.describe('iPad landscape 1180 × 820, the pane\'s actions', () => {
  test.use({ viewport: { width: 1180, height: 820 }, isMobile: false, hasTouch: true, deviceScaleFactor: 1 });

  test('In medical in the 420 px pane: Change answer keeps its whole label beside Reunited; Undo stays left of the pane', async ({ page }) => {
    const [row] = await createRequests(page, 1);
    await setStatus(page, row!, 'Found – Awaiting Reunion', 'answer');
    await page.goto(`/?r=${row!.id}`);
    const pane = page.getByTestId('desk-pane');
    const actions = pane.getByTestId('profile-actions');
    await expect(actions.getByRole('button', { name: 'Reunited' })).toBeVisible({ timeout: 15_000 });
    const change = actions.getByRole('button', { name: 'Change answer' });
    expect(await change.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const svg of await change.locator('svg').all()) expect((await svg.boundingBox())!.width).toBeGreaterThanOrEqual(13);

    await actions.getByRole('button', { name: 'Reunited' }).click();
    const at = await snackPlacement(page);
    expect(at.inView).toBe(true);
    expect(at.uncovered).toBe(true);
    expect(at.box.x).toBeGreaterThanOrEqual(at.column.x);
    expect(at.box.x + at.box.width).toBeLessThanOrEqual(at.pane.x);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(pane.getByTestId('status-block')).toContainText('In medical');
  });
});

test.describe('iPad portrait 820 × 1180 (touch)', () => {
  test.use({ viewport: { width: 820, height: 1180 }, isMobile: false, hasTouch: true, deviceScaleFactor: 1 });

  test('the request is a 480 px sheet over the list, which stays visible and usable', async ({ page }) => {
    const tag = nextTag();
    const rows = await createRequests(page, 2, tag);
    await openSearchResults(page, tag);
    await expect(page.getByTestId('desk-rail')).toBeVisible();
    // Room for the full top bar: the search field with "/" and "New request" (desktop-new-tablet.html).
    await expect(page.getByRole('searchbox', { name: 'Search requests' })).toBeVisible();
    await expect.poll(async () => (await page.getByTestId('desk-new').innerText()).replace(/\s+/g, ' ').trim()).toBe('New request N');

    const order = await rowOrder(page);
    const before = await main(page).boundingBox();
    await row(page, order[0]!).click();
    const pane = page.getByTestId('desk-pane');
    await expect(pane).toBeVisible();
    const box = (await pane.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(480);
    expect(box.width).toBeGreaterThan(400);
    // Over the list: the main column keeps its width, and its left side is still the list (no scrim).
    expect((await main(page).boundingBox())?.width).toBe(before?.width);
    const second = row(page, order[1]!);
    const target = await second.boundingBox();
    const hit = await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y)?.closest('[data-request-id]') as HTMLElement | null)?.dataset.requestId ?? null, {
      x: target!.x + 24,
      y: target!.y + target!.height / 2,
    });
    expect(hit).toBe(order[1]);
    await second.click({ position: { x: 24, y: target!.height / 2 } });
    await expect.poll(() => paramOf(page, 'r')).toBe(order[1]);
    expect(rows.map((r) => r.id)).toContain(order[1]);
  });

  test('All requests opens with the brand row; the sheet answers under its status, and Undo shows at the foot of the sheet', async ({ page }) => {
    const [one] = await createRequests(page, 1);
    await page.goto('/');
    await expect(main(page).locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
    const card = deskBrand(page);
    await expect(card).toBeVisible();
    const title = await brandTitle(card);
    expect(title.size).toBe(19);
    expect(title.height).toBeLessThan(title.size * 1.5);
    expect((await card.boundingBox())!.x).toBeCloseTo(60 + 24, 0);

    await page.goto(`/?r=${one!.id}`);
    const pane = page.getByTestId('desk-pane');
    const actions = pane.getByTestId('profile-actions');
    await expect(actions.getByRole('button', { name: 'Not found', exact: true })).toBeVisible({ timeout: 15_000 });
    const status = (await pane.getByTestId('status-block').boundingBox())!;
    expect((await actions.boundingBox())!.y).toBeGreaterThanOrEqual(status.y + status.height);
    await actions.getByRole('button', { name: 'Not found', exact: true }).click();
    await expect(pane.getByTestId('status-block')).toContainText('Not found in medical');

    // The list beside the sheet is too narrow for it: the bar sits at the foot of the sheet, inside it.
    const at = await snackPlacement(page);
    expect(at.inView).toBe(true);
    expect(at.uncovered).toBe(true);
    expect(at.box.x).toBeGreaterThanOrEqual(at.pane.x);
    expect(at.box.x + at.box.width).toBeLessThanOrEqual(at.pane.x + at.pane.width);
    expect(at.box.y + at.box.height).toBeLessThanOrEqual(at.pane.y + at.pane.height);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(pane.getByTestId('status-block')).toContainText('Waiting for check');
  });
});

test.describe('phone 390 × 844', () => {
  test('unchanged: no desk chrome, and a request is the full screen with nothing behind it', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-iphone14' && testInfo.project.name !== 'webkit-iphone14', 'phone projects only');
    const [one] = await createRequests(page, 1);
    await page.goto('/');
    await expect(page.locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
    for (const id of ['desk-sidebar', 'desk-rail', 'desk-topbar', 'desk-brand']) await expect(page.getByTestId(id)).toHaveCount(0);
    // The list's own brand card (F1), the only one.
    await expect(page.getByTestId('brand-card')).toHaveCount(1);
    await expect(page.locator('[data-view="all"] > [data-testid="brand-card"]')).toBeVisible();
    await expect(page.getByTestId('view-switcher')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New request' })).toBeVisible();

    await page.goto(`/?r=${one!.id}`);
    await expect(page.getByTestId('profile-case')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('desk-pane')).toHaveCount(0);
    await expect(page.locator('[data-request-id]')).toHaveCount(0);
    // Keys are a desk feature.
    await page.locator('body').press('n');
    expect(paramOf(page, 'new')).toBeNull();
  });
});
