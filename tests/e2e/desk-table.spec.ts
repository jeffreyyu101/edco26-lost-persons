import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ChangeResponse, CreateResponse, RequestDetail, RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { axeViolations, overlappingTargets, smallTargets } from './helpers/a11y';
import { signedInAs } from './helpers/session';
import { syncRows } from './helpers/sync';

// The desk request table (components/desk/table; design/screens/desktop-log.html): from 768 px, All
// requests, My requests and Search are a table in the shell's main column. Columns # · Friend · Status ·
// Created · Updated, plus Post and Logged by from 1280 px while nothing is open; open rows first and the
// Archived fold as on F1's phone log; unsent rows on top; the dashboard's filters and their chips; search
// highlighting; the selected row; the skeleton, offline, error and empty states. Under 768 px the phone list
// is unchanged. Synthetic rows only (TEST-table-e2e-…), closed afterwards.

const BASE = testBaseUrl();
const STAFF = { staffName: 'TEST-table Dana', team: 'GC/HX - Dispatch' };
/** The Logged by cell for STAFF ("Dana Kim · Dispatch" shows as "Dana K. · Dispatch"). */
const STAFF_SHORT = 'TEST-table D. · Dispatch';
const TAG = `TEST-table-e2e-${Date.now().toString(36)}`;
const ALL_COLUMNS = ['#', 'Friend', 'Status', 'Post', 'Created', 'Updated', 'Logged by'];
const FIVE_COLUMNS = ['#', 'Friend', 'Status', 'Created', 'Updated'];
const NOT_IN_MEDICAL = 'Checked – Not Found';

test.use({ bypassCSP: true, serviceWorkers: 'block' });
signedInAs(STAFF);

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function api<T>(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

let tagSeq = 0;
/** Each test's own tag, so a search never finds another test's rows. */
const nextTag = () => `${TAG}-t${(tagSeq += 1)}x`;

async function createRequest(page: Page, tag: string, i: number, post = 'FA 3 – Kinetic'): Promise<RequestSummary> {
  const { request } = await api<CreateResponse>(page.request, 'POST', '/api/requests', {
    clientMutationId: randomUUID(),
    reportingLocation: post,
    name: `${tag} P${i}`,
    age: String(20 + i),
    gender: 'Female',
    clothing: `Synthetic ${tag} jacket ${i}`,
    lastSeen: 'kineticFIELD rail',
    contactName: `${tag} Friend`,
    contactPhone: '(407) 555-0142',
    contactRelationship: 'Friend',
  });
  created.push({ id: request.id, request: page.request });
  return request;
}

async function createRequests(page: Page, n: number, tag: string): Promise<RequestSummary[]> {
  const rows: RequestSummary[] = [];
  for (let i = 1; i <= n; i += 1) rows.push(await createRequest(page, tag, i));
  return rows;
}

async function notInMedical(page: Page, row: RequestSummary): Promise<RequestSummary> {
  // (F5) The first Not found only puts the request on hold (still Waiting for check); the second closes it.
  let current = row;
  for (let i = 0; i < 2; i += 1) {
    ({ request: current } = await api<ChangeResponse>(page.request, 'POST', `/api/requests/${row.id}/status`, {
      status: NOT_IN_MEDICAL,
      expectedVersion: current.rowVersion,
      kind: 'answer',
    }));
  }
  return current;
}

test.afterEach(async () => {
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await api<RequestDetail>(request, 'GET', `/api/requests/${id}`);
      if (row.status === 'Added') {
        await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: BASE } });
      }
    } catch {
      // Best effort.
    }
  }
});

const main = (page: Page) => page.locator('[data-desk-main]');
const table = (page: Page) => main(page).getByTestId('request-list');
const row = (page: Page, id: string) => main(page).locator(`[data-request-id="${id}"]`);
const cell = (page: Page, id: string, col: string) => row(page, id).locator(`[data-col="${col}"]`);
const fold = (page: Page) => main(page).getByTestId('closed-fold');
const paramOf = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);
const lp = (n: number) => `LP-${String(n).padStart(4, '0')}`;

/** The column header's labels that are on screen. */
function shownColumns(page: Page): Promise<string[]> {
  return main(page)
    .getByTestId('desk-table-columns')
    .locator('[data-col]')
    .evaluateAll((els) => els.filter((el) => el.getClientRects().length > 0).map((el) => (el.textContent ?? '').trim()));
}

/** Header and row cells start at the same x in every shown column; no cell overlaps the next. */
async function columnsLineUp(page: Page, id: string) {
  const result = await page.evaluate((rowId) => {
    const header = document.querySelector('[data-desk-main] [data-testid="desk-table-columns"]')!;
    const rowEl = document.querySelector(`[data-desk-main] [data-request-id="${rowId}"]`)!;
    const shown = (el: Element) => el.getClientRects().length > 0;
    const heads = Array.from(header.querySelectorAll<HTMLElement>('[data-col]')).filter(shown);
    const cells = Array.from(rowEl.querySelectorAll<HTMLElement>(':scope > [data-col]')).filter(shown);
    const box = (el: Element) => el.getBoundingClientRect();
    return {
      heads: heads.map((h) => h.dataset.col),
      cells: cells.map((c) => c.dataset.col),
      offsets: heads.map((h, i) => Math.abs(box(h).left - box(cells[i]!).left)),
      overlaps: cells.slice(1).map((c, i) => box(cells[i]!).right - box(c).left),
      hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  }, id);
  expect(result.cells).toEqual(result.heads);
  for (const d of result.offsets) expect(d).toBeLessThan(1);
  for (const o of result.overlaps) expect(o).toBeLessThanOrEqual(0.5);
  expect(result.hScroll).toBe(false);
}

/** A cell's text is all on screen (not cut with an ellipsis). */
const notCut = (page: Page, id: string, col: string) => cell(page, id, col).evaluate((el) => el.scrollWidth <= el.clientWidth + 1);

test.describe('desktop 1440 × 900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('All: seven columns, open rows first, the Archived fold; a request open leaves five and is the selected row', async ({ page }) => {
    const tag = nextTag();
    const [, b] = await createRequests(page, 2, tag);
    const closed = await notInMedical(page, await createRequest(page, tag, 3));
    await page.goto('/');
    await expect(row(page, b!.id)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('desk-sidebar')).toBeVisible();
    expect(await shownColumns(page)).toEqual(ALL_COLUMNS);

    // One row, as the mockup: number, name with the age / sex muted, status, post, created, updated, logged by.
    await expect(cell(page, b!.id, 'number')).toHaveText(String(b!.caseNumber));
    await expect(cell(page, b!.id, 'friend')).toContainText(b!.name);
    await expect(cell(page, b!.id, 'friend')).toContainText('22 F');
    // (F5) The stage, then the minutes waiting (design/screens/colors-6.png).
    await expect(cell(page, b!.id, 'status')).toHaveText(/^Waiting for check· (now|\d+m|\d+h)$/);
    await expect(cell(page, b!.id, 'post')).toHaveText('FA 3 – Kinetic');
    await expect(cell(page, b!.id, 'created')).toHaveText(/^(\w{3} )?\d{1,2}:\d\d (AM|PM)$/);
    await expect(cell(page, b!.id, 'updated')).toHaveText('—');
    await expect(cell(page, b!.id, 'by')).toHaveText(STAFF_SHORT);
    await expect(cell(page, b!.id, 'by')).toHaveAttribute('title', 'TEST-table Dana, Dispatch');
    // Blue for Waiting; the row's name is one sentence.
    expect(await cell(page, b!.id, 'status').evaluate((el) => getComputedStyle(el).color)).not.toBe(
      await cell(page, b!.id, 'post').evaluate((el) => getComputedStyle(el).color),
    );
    await expect(row(page, b!.id)).toHaveAccessibleName(
      new RegExp(`^${lp(b!.caseNumber)}, ${b!.name}, 22 F, Waiting for check, created [^,]+, not updated yet, FA 3 – Kinetic, logged by TEST-table Dana, Dispatch$`),
    );
    expect((await row(page, b!.id).boundingBox())!.height).toBeCloseTo(44, 0);
    await columnsLineUp(page, b!.id);

    // Open rows first; every closed one folded under Archived (folded: not on the page).
    const order = () =>
      page.evaluate(() => {
        const items = Array.from(document.querySelectorAll<HTMLElement>('[data-desk-main] [data-request-id], [data-desk-main] [data-testid="closed-fold"]'));
        const at = items.findIndex((el) => el.dataset.testid === 'closed-fold');
        return { at, openFirst: items.slice(0, at).every((el) => el.dataset.closed === undefined), closedAfter: items.slice(at + 1).every((el) => el.dataset.closed !== undefined) };
      });
    expect(await order()).toMatchObject({ openFirst: true, closedAfter: true });
    expect((await order()).at).toBeGreaterThan(0);
    await expect(fold(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(fold(page)).toHaveAccessibleName(/^Archived \d+ requests$/);
    await expect(row(page, closed.id)).toHaveCount(0);

    // The fold opens in place, greyed rows below; it stays open for the session (F1's preference).
    await fold(page).click();
    await expect(fold(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(main(page).getByTestId('closed-rows')).toBeVisible();
    await expect(row(page, closed.id)).toBeVisible();
    await expect(row(page, closed.id)).toHaveAttribute('data-closed', '');
    // (F5) Final after its hold: two checks.
    await expect(cell(page, closed.id, 'status')).toHaveText('Not in medical· 2 checks');
    expect(await order()).toMatchObject({ openFirst: true, closedAfter: true });
    await page.reload();
    await expect(row(page, closed.id)).toBeVisible({ timeout: 15_000 });
    await fold(page).click();
    await expect(row(page, closed.id)).toHaveCount(0);

    // A request open: it docks, the table drops Post and Logged by, and its row is the selected one.
    await row(page, b!.id).click();
    await expect.poll(() => paramOf(page, 'r')).toBe(b!.id);
    await expect(page.getByTestId('desk-pane')).toBeVisible();
    await expect.poll(() => shownColumns(page)).toEqual(FIVE_COLUMNS);
    await expect(row(page, b!.id)).toHaveAttribute('aria-current', 'true');
    await expect(row(page, b!.id)).toHaveAttribute('data-selected', '');
    await columnsLineUp(page, b!.id);
    // J moves the selection with the open request.
    await page.keyboard.press('j');
    await expect.poll(() => paramOf(page, 'r')).not.toBe(b!.id);
    const next = paramOf(page, 'r')!;
    await expect(row(page, next)).toHaveAttribute('aria-current', 'true');
    await expect(row(page, b!.id)).not.toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('k');
    await expect(row(page, b!.id)).toHaveAttribute('aria-current', 'true');
    // Esc closes it: seven columns again, the focus on its row.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('desk-pane')).toHaveCount(0);
    await expect.poll(() => shownColumns(page)).toEqual(ALL_COLUMNS);
    await expect(row(page, b!.id)).toBeFocused();
    await expect(row(page, b!.id)).not.toHaveAttribute('aria-current', 'true');

    // With nothing open: J / ↓ move the focus down the table, K / ↑ up, Enter opens.
    await page.keyboard.press('j');
    await expect(row(page, b!.id)).not.toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(row(page, b!.id)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => paramOf(page, 'r')).toBe(b!.id);
  });

  test("the dashboard's filters: one list with the phone's chips, no fold; clearing a chip widens it", async ({ page }) => {
    const tag = nextTag();
    const [waiting] = await createRequests(page, 1, tag);
    const closed = await notInMedical(page, await createRequest(page, tag, 2));

    await page.goto('/?status=Added');
    await expect(row(page, waiting!.id)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { level: 1, name: /^All requests \d+$/ })).toBeVisible();
    const statusChip = main(page).getByTestId('status-chip');
    await expect(statusChip).toHaveAccessibleName(/^Waiting for check \d+ shown\. Clear this filter$/);
    await expect(fold(page)).toHaveCount(0);
    // (F5) The label, before what follows it ("· 9m").
    expect(new Set((await main(page).locator('[data-request-id] [data-col="status"]').allTextContents()).map((t) => t.replace(/·.*$/, '')))).toEqual(
      new Set(['Waiting for check']),
    );
    const shown = await main(page).locator('[data-request-id]').count();
    await expect(statusChip).toHaveAccessibleName(`Waiting for check ${shown} shown. Clear this filter`);
    await statusChip.click();
    await expect.poll(() => new URL(page.url()).search).toBe('');
    await expect(fold(page)).toBeVisible();

    // A dashboard "Open by post" bar: the open requests at that post, Open and post chips.
    await page.goto('/?post=FA+3+%E2%80%93+Kinetic&open=1');
    await expect(row(page, waiting!.id)).toBeVisible({ timeout: 15_000 });
    await expect(row(page, closed.id)).toHaveCount(0);
    await expect(main(page).getByTestId('open-chip')).toBeVisible();
    const posts = new Set(await main(page).locator('[data-request-id] [data-col="post"]').allTextContents());
    expect(posts).toEqual(new Set(['FA 3 – Kinetic']));
    const n = await main(page).locator('[data-request-id]').count();
    await expect(main(page).getByTestId('post-chip')).toHaveAccessibleName(`FA 3 – Kinetic ${n} shown. Clear this filter`);
    // Clearing Open shows every request at the post, the closed ones greyed in place.
    await main(page).getByTestId('open-chip').click();
    await expect.poll(() => paramOf(page, 'open')).toBeNull();
    await expect(row(page, closed.id)).toBeVisible();
    await expect(row(page, closed.id)).toHaveAttribute('data-closed', '');
    await expect(fold(page)).toHaveCount(0);
  });

  test('My requests: open first, then Closed; an unsent request sits on top of it and of All until it sends', async ({ page, context }) => {
    const tag = nextTag();
    const [mineOpen] = await createRequests(page, 1, tag);
    const mineClosed = await notInMedical(page, await createRequest(page, tag, 2));
    await page.goto('/?view=mine');
    await expect(row(page, mineOpen!.id)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { level: 1, name: /^My requests \d+$/ })).toBeVisible();
    const group = main(page).getByTestId('mine-closed');
    await expect(group).toHaveAccessibleName(/^Closed, \d+$/);
    await expect(group.locator(`[data-request-id="${mineClosed.id}"]`)).toBeVisible();
    await expect(group.locator(`[data-request-id="${mineOpen!.id}"]`)).toHaveCount(0);
    await expect(fold(page)).toHaveCount(0);
    expect((await row(page, mineOpen!.id).boundingBox())!.y).toBeLessThan((await group.boundingBox())!.y);

    // A request saved offline: on top of My requests and All, as on the phone.
    const name = `${tag} Queued`;
    await page.locator('body').press('n');
    const submit = page.getByTestId('request-form-submit');
    await expect(submit).toBeVisible();
    await page.getByRole('button', { name: /^Reporting from/ }).click();
    const picker = page.getByRole('dialog', { name: 'Reporting from' });
    await picker.locator('label', { hasText: 'FA 4 – Oasis' }).click();
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect(picker).toBeHidden();
    await page.getByRole('group', { name: 'Missing person' }).getByLabel('Name', { exact: true }).fill(name);
    await context.setOffline(true);
    await expect(submit).toContainText('Save offline');
    await submit.click();
    await expect(page.getByTestId('request-form')).toHaveCount(0);

    const queued = main(page).getByRole('group', { name: new RegExp(`^${name}, [^.]+\\. Waiting to send, FA 4, Not sent\\.$`) });
    await expect(queued).toBeVisible();
    await expect(queued.locator('[data-col="status"]')).toHaveText('Waiting to send');
    await expect(queued.locator('[data-col="updated"]')).toHaveText('—');
    await expect(main(page).getByText('Offline · 1 waiting to send')).toBeVisible();
    const firstRow = () =>
      page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-desk-main] [data-testid="request-list"] :is([data-request-id], [data-outbox-id])');
        return el?.dataset.outboxId ? 'outbox' : el?.dataset.requestId ?? null;
      });
    expect(await firstRow()).toBe('outbox');
    await page.getByTestId('desk-sidebar').getByRole('link', { name: /^All requests/ }).click();
    await expect(queued).toBeVisible();
    expect(await firstRow()).toBe('outbox');

    // Back online it sends once and becomes a request row.
    await context.setOffline(false);
    await expect(queued).toHaveCount(0, { timeout: 30_000 });
    let sent: RequestSummary | undefined;
    await expect
      .poll(async () => (sent = (await syncRows<RequestSummary>(page.request)).find((r) => r.name === name)) !== undefined, { timeout: 15_000 })
      .toBe(true);
    created.push({ id: sent!.id, request: page.request });
    await expect(row(page, sent!.id)).toBeVisible({ timeout: 15_000 });
    await expect(cell(page, sent!.id, 'post')).toHaveText('FA 4 – Oasis');
  });

  test('Search: the top bar query lists matches newest first with the match highlighted', async ({ page }) => {
    const tag = nextTag();
    const [a] = await createRequests(page, 1, tag);

    // A description match: highlighted in the matched text under the name.
    await page.goto(`/?q=${encodeURIComponent(`${tag} jacket`)}`);
    await expect(row(page, a!.id)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
    await expect(row(page, a!.id).locator('mark')).toHaveText(`${tag} jacket`);
    await expect(row(page, a!.id)).toHaveAccessibleName(new RegExp(`\\. Synthetic ${tag} jacket 1$`));
    await expect(main(page).getByRole('status').filter({ hasText: /^1 result$/ })).toHaveCount(1);
    expect(await shownColumns(page)).toEqual(ALL_COLUMNS);

    // A name match is highlighted in place; a number match in the number column.
    const field = page.getByRole('searchbox', { name: 'Search requests' });
    await field.fill(`${tag} P1`);
    await expect(row(page, a!.id).locator('[data-col="friend"] mark')).toHaveText(`${tag} P1`);
    await field.fill(String(a!.caseNumber));
    await expect(row(page, a!.id).locator('[data-col="number"] mark')).toHaveText(String(a!.caseNumber));
    await field.fill(`${tag}-nothing`);
    await expect(main(page).getByText('No matches', { exact: true })).toBeVisible();
    await expect(main(page).locator('[data-request-id]')).toHaveCount(0);
  });

  test("states: the skeleton before the first sync, then the table; a failing sync shows the red banner", async ({ page }) => {
    await page.route('**/api/sync*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await page.goto('/');
    const skeleton = main(page).getByTestId('desk-table-skeleton');
    await expect(skeleton).toBeVisible();
    await expect(skeleton.getByTestId('desk-table-columns')).toBeAttached();
    expect(await shownColumns(page)).toEqual(ALL_COLUMNS);
    await expect(table(page)).toBeVisible({ timeout: 15_000 });
    await expect(skeleton).toHaveCount(0);

    // The sync starts failing with data on screen: the table stays, "Can't reach the log" above it.
    await page.unroute('**/api/sync*');
    await page.route('**/api/sync*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"unavailable","message":"down"}}' }));
    const banner = main(page).getByRole('status').filter({ hasText: "Can't reach the log" });
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(table(page)).toBeVisible();
    expect((await banner.boundingBox())!.y).toBeLessThan((await table(page).boundingBox())!.y);
  });

  test("states: with no data and no server, \"Can't reach the log\" and Try again", async ({ page }) => {
    await page.route('**/api/sync*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"unavailable","message":"down"}}' }));
    await page.goto('/');
    await expect(main(page).getByText("Can't reach the log", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(table(page)).toHaveCount(0);
    await page.unroute('**/api/sync*');
    await main(page).getByRole('button', { name: 'Try again' }).click();
    await expect(table(page)).toBeVisible({ timeout: 15_000 });
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`passes axe with Archived open and a filter chip (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('lp-theme', t);
          sessionStorage.setItem('lp-closed-expanded', '1');
        } catch {
          // ignore
        }
      }, theme);
      const tag = nextTag();
      await createRequests(page, 1, tag);
      await notInMedical(page, await createRequest(page, tag, 2));
      await page.goto('/');
      await expect(main(page).getByTestId('closed-rows')).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(400);
      expect(await axeViolations(page)).toEqual([]);
      await page.goto('/?post=FA+3+%E2%80%93+Kinetic&open=1');
      await expect(main(page).getByTestId('post-chip')).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(400);
      expect(await axeViolations(page)).toEqual([]);
    });
  }
});

test.describe('iPad landscape 1180 × 820 (touch)', () => {
  test.use({ viewport: { width: 1180, height: 820 }, isMobile: false, hasTouch: true, deviceScaleFactor: 1 });

  test('five columns with or without a request open; nothing cut but names; 44 px rows and chips', async ({ page }) => {
    const tag = nextTag();
    const [one] = await createRequests(page, 1, tag);
    await page.goto('/');
    await expect(row(page, one!.id)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('desk-rail')).toBeVisible();
    expect(await shownColumns(page)).toEqual(FIVE_COLUMNS);
    await columnsLineUp(page, one!.id);

    // Docked at 420 px: the main column is 700 px; the tighter grid keeps the status label whole.
    await row(page, one!.id).click();
    await expect(page.getByTestId('desk-pane')).toBeVisible();
    expect(await shownColumns(page)).toEqual(FIVE_COLUMNS);
    await columnsLineUp(page, one!.id);
    for (const col of ['number', 'status', 'created', 'updated']) expect(await notCut(page, one!.id, col), col).toBe(true);
    await expect(row(page, one!.id)).toHaveAttribute('aria-current', 'true');

    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    test.skip(!coarse, 'this browser does not report a coarse pointer for touch emulation');
    await page.goto('/?post=FA+3+%E2%80%93+Kinetic&open=1');
    await expect(main(page).getByTestId('post-chip')).toBeVisible({ timeout: 15_000 });
    const scope = '[data-desk-main] [data-testid="desk-filter-chips"]';
    expect(await smallTargets(page, scope)).toEqual([]);
    expect(await overlappingTargets(page, scope)).toEqual([]);
    expect((await row(page, one!.id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe('1024 × 768 with a request open', () => {
  test.use({ viewport: { width: 1024, height: 768 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('the narrowest main column (544 px) keeps every column but the name whole', async ({ page }) => {
    const tag = nextTag();
    const [one] = await createRequests(page, 1, tag);
    await page.goto(`/?r=${one!.id}`);
    await expect(page.getByTestId('desk-pane')).toBeVisible({ timeout: 15_000 });
    await expect(row(page, one!.id)).toBeVisible({ timeout: 15_000 });
    expect(await shownColumns(page)).toEqual(FIVE_COLUMNS);
    await columnsLineUp(page, one!.id);
    for (const col of ['number', 'status', 'created', 'updated']) expect(await notCut(page, one!.id, col), col).toBe(true);
  });
});

test.describe('iPad portrait 820 × 1180 (touch)', () => {
  test.use({ viewport: { width: 820, height: 1180 }, isMobile: false, hasTouch: true, deviceScaleFactor: 1 });

  test('the table under the icon rail, five columns; a request is a sheet over it, its row selected', async ({ page }) => {
    const tag = nextTag();
    const [one] = await createRequests(page, 1, tag);
    await page.goto('/');
    await expect(row(page, one!.id)).toBeVisible({ timeout: 15_000 });
    expect(await shownColumns(page)).toEqual(FIVE_COLUMNS);
    await columnsLineUp(page, one!.id);
    await expect(main(page).getByTestId('view-switcher')).toHaveCount(0);
    await row(page, one!.id).click();
    await expect(page.getByTestId('desk-pane')).toBeVisible();
    expect(await shownColumns(page)).toEqual(FIVE_COLUMNS);
    await expect(row(page, one!.id)).toHaveAttribute('aria-current', 'true');
  });
});

test.describe('phone 390 × 844', () => {
  test('unchanged: the phone log, no desk table', async ({ page }) => {
    const tag = nextTag();
    const [one] = await createRequests(page, 1, tag);
    await page.goto('/');
    await expect(page.locator(`[data-request-id="${one!.id}"]`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('desk-table-view')).toHaveCount(0);
    await expect(page.getByTestId('desk-table-columns')).toHaveCount(0);
    await expect(page.getByTestId('log-columns')).toBeVisible();
    await expect(page.getByTestId('brand-card')).toBeVisible();
    await expect(page.getByTestId('view-switcher')).toBeVisible();
    for (const url of ['/?view=mine', `/?q=${encodeURIComponent(tag)}`]) {
      await page.goto(url);
      await expect(page.locator(`[data-request-id="${one!.id}"]`).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('desk-table-view'), url).toHaveCount(0);
    }
  });
});
