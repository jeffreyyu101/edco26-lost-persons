import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ChangeResponse, CreateResponse, RequestDetail, RequestSummary } from '../../lib/api-types';
import { signedInAs } from './helpers/session';

// Dashboard and account menu (spec §8 Dashboard / Avatar menu, §9.4 "dashboard numbers, and a tile filtering
// All"). The global view (design/screens/polish-v7.html): status tiles, Open by post, Recently updated,
// Performance; no Export CSV (Jeffrey exports from Supabase, docs/export.sql). The database is shared, so
// numbers are asserted as DELTAS from what the dashboard showed before this test's own changes (v2.1 A17),
// never as seed totals. Stats poll every 15 s. Runs at integration against the real store and API, except
// where /api/stats is mocked to pin the Performance values. Synthetic rows only (TEST-P-D…), closed afterwards.

const FRONT = { staffName: 'TEST-P Dashboard', team: 'GC/HX - Base' };

// Signed in once through POST /api/session (A17).
signedInAs(FRONT);

const POLL = { timeout: 40_000, intervals: [1_000, 2_000, 5_000] };

const unique = () => `TEST-P-D${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const created: Array<{ id: string; request: APIRequestContext }> = [];

async function api<T>(request: APIRequestContext, origin: string, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: origin } });
  expect(res.ok(), `${method} ${path} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function createRequest(page: Page, origin: string, reportingLocation: string, otherLocation?: string): Promise<RequestSummary> {
  const { request } = await api<CreateResponse>(page.request, origin, 'POST', '/api/requests', {
    clientMutationId: randomUUID(),
    reportingLocation,
    ...(otherLocation ? { otherLocation } : {}),
    name: unique(),
    age: 22,
    gender: 'Male',
    clothing: 'Yellow raincoat',
  });
  created.push({ id: request.id, request: page.request });
  return request;
}

/** The number at the end of a legend row / tile / bar ("Waiting for check 4" → 4). */
async function count(locator: Locator): Promise<number> {
  const text = (await locator.innerText()).trim();
  const m = /(\d+)\s*$/.exec(text) ?? /(\d+)/.exec(text);
  return m ? Number(m[1]) : Number.NaN;
}

async function numbers(page: Page) {
  return {
    open: Number(await page.getByTestId('open-count').innerText()),
    waiting: await count(page.getByTestId('tile-waiting')),
    inMedical: await count(page.getByTestId('tile-in-medical')),
    fa4: await count(page.getByRole('button', { name: /^FA 4 – Oasis \d+ open$/ })),
  };
}

/** Closed = Not found in medical + Reunited + Discharged + Cancelled, as the tiles show them. */
async function closedNumbers(page: Page) {
  const value = async (id: string) => Number(await page.getByTestId(`${id}-value`).innerText());
  return {
    closed: await value('tile-closed'),
    notInMedical: await value('tile-not-in-medical'),
    reunited: await value('tile-reunited'),
  };
}

test.afterEach(async ({ baseURL }) => {
  const origin = baseURL as string;
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await api<RequestDetail>(request, origin, 'GET', `/api/requests/${id}`);
      if (row.status === 'Added') {
        await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: origin } });
      } else if (row.status === 'Found – Awaiting Reunion') {
        await request.fetch(`/api/requests/${id}/status`, {
          method: 'POST',
          data: { status: 'Reunited – Closed', expectedVersion: row.rowVersion, kind: 'reunite' },
          headers: { Origin: origin },
        });
      }
    } catch {
      // Best effort.
    }
  }
});

test('open counts move by the deltas of this test, and tiles and bars open All filtered', async ({ page, baseURL }) => {
  const origin = baseURL as string;
  await page.goto('/?dashboard=1');
  await expect(page.getByTestId('open-count')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  // Healthy: no pill, no chip, no banner; the line under the title counts from the last stats fetch.
  await expect(page.getByTestId('live-indicator')).toHaveAttribute('data-state', 'healthy');
  await expect(page.getByTestId('live-text')).toHaveText('Updated just now');
  await expect(page.getByTestId('live-indicator')).toContainText('Dashboard updated just now.');
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);
  await expect(page.getByTestId('dashboard-connection')).toHaveCount(0);
  await expect(page.getByText('Live', { exact: true })).toHaveCount(0);
  // Export CSV is gone from the dashboard.
  await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export CSV' })).toHaveCount(0);
  const before = await numbers(page);
  expect(before.open).toBe(before.waiting + before.inMedical);
  const closedBefore = await closedNumbers(page);
  expect(closedBefore.closed).toBeGreaterThanOrEqual(closedBefore.notInMedical + closedBefore.reunited);

  // A closed request at FA 4 (cancelled): the FA 4 bar never counts it, so its list must not show it.
  const closed = await createRequest(page, origin, 'FA 4 – Oasis');
  await api<ChangeResponse>(page.request, origin, 'POST', `/api/requests/${closed.id}/cancel`, { expectedVersion: closed.rowVersion });

  // A new request at FA 4: open +1, waiting +1, FA 4 +1.
  const row = await createRequest(page, origin, 'FA 4 – Oasis');
  await expect
    .poll(() => numbers(page), POLL)
    .toEqual({ open: before.open + 1, waiting: before.waiting + 1, inMedical: before.inMedical, fa4: before.fa4 + 1 });

  // Answered In medical: still open, moves from waiting to in medical.
  await api<ChangeResponse>(page.request, origin, 'POST', `/api/requests/${row.id}/status`, {
    status: 'Found – Awaiting Reunion',
    expectedVersion: row.rowVersion,
    kind: 'answer',
  });
  await expect
    .poll(() => numbers(page), POLL)
    .toEqual({ open: before.open + 1, waiting: before.waiting, inMedical: before.inMedical + 1, fa4: before.fa4 + 1 });

  // The cancelled one counts as closed (Closed = Not found in medical + Reunited + Discharged + Cancelled).
  await expect.poll(async () => (await closedNumbers(page)).closed, POLL).toBeGreaterThanOrEqual(closedBefore.closed + 1);

  // Recently updated lists it, number first, and opens its profile.
  const recent = page.getByRole('region', { name: 'Recently updated' });
  const recentRow = recent.getByRole('button', { name: new RegExp(row.name) });
  await expect(recentRow).toBeVisible();
  // The number leads the row; the name starts with what the row shows (WCAG 2.5.3).
  await expect(recentRow).toHaveAccessibleName(new RegExp(`^${row.caseNumber} ${row.name} In medical (now|\\d+m)\\. In medical · friend coming, FA 4, updated `));
  expect((await recentRow.innerText()).replace(/\s+/g, ' ').trim()).toMatch(new RegExp(`^${row.caseNumber} ${row.name} In medical (now|\\d+m)$`));
  await recentRow.click();
  await expect(page).toHaveURL(new RegExp(`\\?r=${row.id}$`));
  await expect(page.getByTestId('profile')).toBeVisible();
  await page.goBack();

  // The section header is the link to All requests.
  await page.getByRole('button', { name: 'Recently updated. Show all requests' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('request-list')).toBeVisible();
  await page.goBack();

  // Status tiles and bars open All filtered; Open opens Pending (exactly the open requests).
  await page.getByTestId('tile-not-in-medical').click();
  await expect(page).toHaveURL(/\?status=Checked\+%E2%80%93\+Not\+Found$/);
  await expect(page.getByTestId('request-list')).toBeVisible();
  await page.goBack();
  await page.getByTestId('tile-in-medical').click();
  await expect(page).toHaveURL(/\?status=Found\+%E2%80%93\+Awaiting\+Reunion$/);
  await expect(page.locator(`[data-request-id="${row.id}"]`)).toBeVisible();
  await page.goBack();
  await page.getByTestId('tile-waiting').click();
  await expect(page).toHaveURL(/\?status=Added$/);
  await page.goBack();
  await page.getByTestId('tile-reunited').click();
  await expect(page).toHaveURL(/\?status=Reunited\+%E2%80%93\+Closed$/);
  await page.goBack();
  await page.getByTestId('tile-open').click();
  await expect(page).toHaveURL(/\?view=pending$/);
  // Pending v9.1 is one page: the In medical request is under Friend coming, below Waiting for check.
  await expect(page.locator(`[data-testid="friend-coming-card"] [data-request-id="${row.id}"]`)).toBeVisible();
  await page.goBack();
  // Regression: the bar opens the open requests it counts (?open=1), so the chip's count is the bar's.
  const fa4Bar = page.getByRole('button', { name: /^FA 4 – Oasis \d+ open$/ });
  const fa4Open = await count(fa4Bar);
  await fa4Bar.click();
  await expect(page).toHaveURL(/\?post=FA\+4\+%E2%80%93\+Oasis&open=1$/);
  await expect(page.getByTestId('open-chip')).toBeVisible();
  await expect(page.getByTestId('post-chip')).toContainText('FA 4 – Oasis');
  await expect(page.getByTestId('post-chip')).toHaveAccessibleName(`FA 4 – Oasis ${fa4Open} shown. Clear this filter`);
  await expect(page.locator(`[data-request-id="${row.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-request-id="${closed.id}"]`)).toHaveCount(0);
  // Clearing Open widens it to every request at the post, closed ones included.
  await page.getByTestId('open-chip').click();
  await expect(page).toHaveURL(/\?post=FA\+4\+%E2%80%93\+Oasis$/);
  await expect(page.locator(`[data-request-id="${closed.id}"]`)).toBeVisible();
  await page.goBack();

  // Back to the list.
  await page.getByRole('button', { name: 'Back to requests' }).click();
  await expect(page.getByTestId('dashboard')).toHaveCount(0);
});

test('an Other location named like a fixed post gets its own bar and filter', async ({ page, baseURL }) => {
  const origin = baseURL as string;
  const fixed = await createRequest(page, origin, 'Base');
  const other = await createRequest(page, origin, 'Other', 'Base');
  await page.goto('/?dashboard=1');
  const baseBar = page.getByRole('button', { name: /^Base \d+ open$/ });
  const otherBar = page.getByRole('button', { name: /^Other · Base \d+ open$/ });
  await expect(baseBar).toBeVisible();
  await expect(otherBar).toBeVisible();
  await expect(otherBar).toContainText('Other · Base');

  // Each bar lists exactly its own rows, the open ones it counts: every listed row is open, and there are
  // as many as the bar says.
  // A log row (option B) is named by its content, one screen-reader sentence with no aria-label:
  // "LP-1013, T.R., Waiting for check, created 11:02 PM, not updated yet".
  const openListed = async () => {
    await expect(page.getByTestId('request-list')).toBeVisible();
    const rows = page.getByTestId('request-list').locator('[data-request-id]');
    const openRows = rows.and(page.getByRole('button', { name: /, (Waiting for check|In medical)\b/ }));
    const listed = await rows.count();
    const open = await openRows.count();
    expect(open, (await rows.allTextContents()).join('\n')).toBe(listed);
    return open;
  };
  const otherCount = await count(otherBar);
  await otherBar.click();
  await expect(page).toHaveURL(/\?post=Other%3ABase&open=1$/);
  await expect(page.getByTestId('post-chip')).toHaveAccessibleName(/^Other · Base \d+ shown\. Clear this filter$/);
  await expect(page.locator(`[data-request-id="${other.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-request-id="${fixed.id}"]`)).toHaveCount(0);
  expect(await openListed()).toBe(otherCount);
  await page.goBack();

  const baseCount = await count(baseBar);
  await baseBar.click();
  await expect(page).toHaveURL(/\?post=Base&open=1$/);
  await expect(page.getByTestId('post-chip')).toHaveAccessibleName(/^Base \d+ shown\. Clear this filter$/);
  await expect(page.locator(`[data-request-id="${fixed.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-request-id="${other.id}"]`)).toHaveCount(0);
  expect(await openListed()).toBe(baseCount);
});

test('the account menu shows who is signed in, switches theme, and opens the dashboard', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('account-trigger').click();
  const menu = page.getByRole('dialog', { name: 'Account' });
  await expect(menu).toContainText(FRONT.staffName);
  await expect(menu).toContainText('GCHX Base');
  await expect(menu).toContainText('Built by Jeffrey Yu');

  await menu.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await page.getByTestId('account-trigger').click();
  await page.getByRole('dialog', { name: 'Account' }).getByRole('radio', { name: 'Auto' }).click();
  expect(await page.evaluate(() => localStorage.getItem('lp-theme'))).toBeNull();

  await page.getByRole('dialog', { name: 'Account' }).getByRole('button', { name: 'Dashboard' }).click();
  await expect(page).toHaveURL(/\?dashboard=1$/);
  await expect(page.getByTestId('open-count')).toBeVisible();
});

// ---------------------------------------------------------------------------------------------------
// Mocked /api/stats: Performance values, "—" for what the server does not send, and the layout
// (design/screens/v7-dash.png on a phone, v7-laptop.png at 768 px and wider). Synthetic numbers only.
// ---------------------------------------------------------------------------------------------------

function mockStats(over: Record<string, unknown> = {}) {
  const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const id = (n: number) => `5eed0000-0000-4000-8000-00000000${n}`;
  return {
    open: { waiting: 4, inMedical: 3 },
    notInMedical: 2,
    reunited: 2,
    discharged: 1,
    cancelled: 1,
    total: 13,
    longestWait: { id: id(1010), caseNumber: 1010, reportingLocation: 'FA 4 – Oasis', otherLocation: null, postShort: 'FA 4', minutes: 24 },
    avgAnswerMinutes: 9,
    avgReuniteMinutes: 18,
    loggedLastHour: 6,
    byPost: [
      { reportingLocation: 'FA 3 – Kinetic', otherLocation: null, postShort: 'FA 3', count: 3 },
      { reportingLocation: 'FA 4 – Oasis', otherLocation: null, postShort: 'FA 4', count: 1 },
      { reportingLocation: 'Command', otherLocation: null, postShort: 'Command', count: 0 },
      { reportingLocation: 'Base', otherLocation: null, postShort: 'Base', count: 3 },
    ],
    recent: [
      { id: id(1007), caseNumber: 1007, name: 'TEST-P-D Jordan', status: 'Found – Awaiting Reunion', postShort: 'FA 4', updatedAt: ago(2) },
      { id: id(1009), caseNumber: 1009, name: 'TEST-P-D A.N.', status: 'Checked – Not Found', postShort: 'FA 3', updatedAt: ago(6) },
    ],
    serverTime: new Date().toISOString(),
    ...over,
  };
}

async function routeStats(page: Page, body: Record<string, unknown>) {
  await page.route('**/api/stats', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
}

const value = (page: Page, id: string) => page.getByTestId(`${id}-value`);

/** Rounded bounding box of a test id. */
async function box(page: Page, testId: string) {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} has no box`);
  return { x: Math.round(b.x), y: Math.round(b.y), right: Math.round(b.x + b.width), bottom: Math.round(b.y + b.height) };
}

async function regionBox(page: Page, name: string) {
  const b = await page.getByRole('region', { name }).boundingBox();
  if (!b) throw new Error(`${name} has no box`);
  return b;
}

// page.route() never sees a request the service worker answers, so these run without it.
test.describe('with /api/stats mocked', () => {
  test.use({ serviceWorkers: 'block' });

  test('Performance rows: Longest wait opens the request; averages and Logged show their values', async ({ page }) => {
    await routeStats(page, mockStats());
    await page.goto('/?dashboard=1');
    await expect(page.getByTestId('open-count')).toHaveText('7');
    await expect(value(page, 'tile-closed')).toHaveText('6');
    // (Non-breaking spaces inside each part: a narrow tile wraps only after the "·".)
    await expect(page.getByTestId('reunited-sub')).toContainText('+1\u00a0discharged\u00a0· 1\u00a0cancelled');
    await expect(value(page, 'perf-longest-wait')).toHaveText('24m');
    await expect(page.getByTestId('perf-longest-wait')).toContainText('1010 · FA 4');
    await expect(value(page, 'perf-answer')).toHaveText('9m');
    await expect(value(page, 'perf-reunite')).toHaveText('18m');
    await expect(value(page, 'perf-logged')).toHaveText('6');
    // Busiest post first, ties in the server's order, zero last.
    const posts = await page
      .getByRole('region', { name: 'Open by post' })
      .getByRole('button')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(posts).toEqual(['FA 3 – Kinetic 3 open', 'Base 3 open', 'FA 4 – Oasis 1 open', 'Command 0 open']);
    await page.getByRole('button', { name: /^Longest wait 1010 · FA 4 24m\. Request 1010 at FA 4 has been waiting 24 minutes/ }).click();
    await expect(page).toHaveURL(/\?r=5eed0000-0000-4000-8000-000000001010$/);
  });

  test('Performance shows "None" for values the server leaves null or out (Brian 2026-11-06 21:55), and no sub without discharged / cancelled', async ({ page }) => {
    const stats = mockStats({ longestWait: null, avgAnswerMinutes: null, avgReuniteMinutes: null, discharged: 0, cancelled: 0 });
    delete (stats as Record<string, unknown>).loggedLastHour;
    await routeStats(page, stats);
    await page.goto('/?dashboard=1');
    for (const id of ['perf-longest-wait', 'perf-answer', 'perf-reunite', 'perf-logged']) await expect(value(page, id)).toHaveText('None');
    await expect(page.getByTestId('perf-answer-context')).toHaveText('last 2 hours');
    await expect(page.getByTestId('perf-reunite-context')).toHaveText('last 2 hours');
    await expect(page.getByTestId('perf-logged-context')).toHaveText('last hour');
    // Without a waiting request there is nothing to open.
    await expect(page.getByRole('button', { name: /^Longest wait/ })).toHaveCount(0);
    await expect(page.getByTestId('reunited-sub')).toHaveCount(0);
    await expect(value(page, 'tile-closed')).toHaveText('4');
  });

  test('the line under the title follows the list rules: "Updated just now", the Offline / Reconnecting banner with "Last updated <time>" (back online recovers without a tap; one failed fetch shows nothing), Refresh now fetches the stats', async ({ page, context }) => {
    test.slow();
    await page.goto('/?dashboard=1');
    await expect(page.getByTestId('open-count')).toBeVisible();
    const line = page.getByTestId('live-indicator');
    const text = page.getByTestId('live-text');
    const banner = page.getByTestId('connection-banner');
    const refresh = page.getByRole('button', { name: 'Refresh now', exact: true });
    await expect(line).toHaveAttribute('data-state', 'healthy');
    await expect(text).toHaveText('Updated just now');
    await expect(banner).toHaveCount(0);
    // Under the title, lined up with it; Refresh now right after the words.
    const title = (await page.getByRole('heading', { level: 1, name: 'Dashboard' }).boundingBox())!;
    const box = (await line.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(title.y + title.height - 4);
    expect(Math.abs(box.x + 30 - title.x)).toBeLessThan(2);
    const words = (await text.boundingBox())!;
    const button = (await refresh.boundingBox())!;
    expect(button.x - (words.x + words.width)).toBeLessThan(4);

    // Refresh now: exactly one immediate stats fetch (and no list sync, no reload); the glyph turns meanwhile.
    await page.evaluate(() => {
      (window as unknown as { __noReload: boolean }).__noReload = true;
    });
    const fetches: string[] = [];
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (path === '/api/stats') fetches.push(path);
    });
    await page.route('**/api/stats', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockStats()) });
    });
    await refresh.click();
    await expect(refresh).toHaveAttribute('data-refreshing', '');
    await refresh.click();
    await expect(refresh).not.toHaveAttribute('data-refreshing', { timeout: 10_000 });
    expect(fetches).toHaveLength(1);
    await expect(text).toHaveText('Updated just now');
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

    // Offline: the gray banner under the header, and the fixed clock time on the line.
    await page.unroute('**/api/stats');
    const isStats = (r: { url(): string }) => new URL(r.url()).pathname === '/api/stats';
    await context.setOffline(true);
    let backOnline = false;
    try {
      await expect(line).toHaveAttribute('data-state', 'offline', { timeout: 15_000 });
      await expect(banner).toHaveText(/^Offline · \d+ waiting to send$/);
      await expect(banner).toHaveAttribute('data-tone', 'gray');
      await expect(text).toHaveText(/^Last updated \d{1,2}:\d{2} (AM|PM)$/);
      await expect(page.getByTestId('live-announcement')).toHaveText('Offline');
      // The banner sits under the header, above the numbers, which stay on screen.
      expect((await banner.boundingBox())!.y).toBeGreaterThan(box.y);
      expect((await page.getByTestId('tile-open').boundingBox())!.y).toBeGreaterThan((await banner.boundingBox())!.y);
      // Stats fetches that fail while offline (two, past the network threshold): still just Offline.
      for (let i = 0; i < 2; i += 1) {
        await refresh.click();
        await expect(refresh).not.toHaveAttribute('data-refreshing', { timeout: 15_000 });
      }
      await expect(line).toHaveAttribute('data-state', 'offline');
      await expect(banner).toHaveText(/^Offline · \d+ waiting to send$/);
      // Back online, no tap: the stats go out at once (the next poll is 15 s away), and the banner goes with the
      // lists', not a poll later.
      const statsBack = page.waitForRequest(isStats, { timeout: 8_000 });
      await context.setOffline(false);
      backOnline = true;
      await statsBack;
    } finally {
      if (!backOnline) await context.setOffline(false);
    }
    await expect(banner).toHaveCount(0, { timeout: 8_000 });
    await expect(line).toHaveAttribute('data-state', 'healthy');
    await expect(text).toHaveText('Updated just now');
    await expect(page.getByTestId('live-announcement')).toHaveText('Back online');

    // Stats that fail with a server error: one shows nothing (the lists' thresholds: 3 in a row); the 3rd is
    // the amber Reconnecting banner and "Last updated <time>". A refresh that fails changes nothing else (no toast).
    await page.route('**/api/stats', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"unavailable","message":"Try again"}}' }));
    await refresh.click();
    await expect(refresh).not.toHaveAttribute('data-refreshing', { timeout: 10_000 });
    await expect(banner).toHaveCount(0);
    await expect(line).toHaveAttribute('data-state', 'healthy');
    await expect(text).toHaveText('Updated just now');
    for (let i = 0; i < 2; i += 1) {
      await refresh.click();
      await expect(refresh).not.toHaveAttribute('data-refreshing', { timeout: 10_000 });
    }
    await expect(banner).toHaveText('Reconnecting…');
    await expect(banner).toHaveAttribute('data-tone', 'amber');
    await expect(line).toHaveAttribute('data-state', 'reconnecting');
    await expect(text).toHaveText(/^Last updated \d{1,2}:\d{2} (AM|PM)$/);
    await expect(page.getByTestId('live-announcement')).toHaveText('Reconnecting');
    await expect(page.getByTestId('open-count')).toBeVisible();
    await expect(page.locator('.lp-toast')).toHaveCount(0);
    await page.unroute('**/api/stats');
    await refresh.click();
    await expect(line).toHaveAttribute('data-state', 'healthy', { timeout: 15_000 });
    await expect(text).toHaveText('Updated just now');
    await expect(banner).toHaveCount(0);
    await expect(page.getByTestId('live-announcement')).toHaveText('Back online');
  });

  test('phone: two tiles per row, Open and Closed on one baseline, sections stacked; nothing but names cut', async ({ page }) => {
    const long = { ...mockStats().recent[0], name: 'TEST-P-D Alexandria Montgomery-Fitzgerald the Third' };
    await routeStats(page, mockStats({ recent: [long] }));
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/?dashboard=1');
    await expect(page.getByTestId('open-count')).toHaveText('7');
    const open = await box(page, 'tile-open');
    const closed = await box(page, 'tile-closed');
    const waiting = await box(page, 'tile-waiting');
    expect(closed.y).toBe(open.y);
    expect(waiting.y).toBeGreaterThan(open.bottom);
    // The two big numbers sit on one line.
    expect((await box(page, 'open-count')).bottom).toBe((await box(page, 'tile-closed-value')).bottom);
    // Not found in medical's number lines up with Reunited's even though Reunited has a second line.
    expect((await box(page, 'tile-not-in-medical-value')).bottom).toBe((await box(page, 'tile-reunited-value')).bottom);
    const posts = await regionBox(page, 'Open by post');
    const recent = await regionBox(page, 'Recently updated');
    expect(recent.y).toBeGreaterThan(posts.y + posts.height - 1);
    const overflow = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="dashboard"] *'))) {
        const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent?.trim());
        if (!ownText || el.clientWidth <= 1 || el.closest('svg')) continue;
        if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.textContent} (${getComputedStyle(el).textOverflow})`);
      }
      return { out, hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    expect(overflow.hScroll).toBe(false);
    expect(overflow.out).toEqual(['TEST-P-D Alexandria Montgomery-Fitzgerald the Third (ellipsis)']);
  });

  // Regression: an Other location's free text (up to 80 characters) in the Longest wait context pushed the
  // minutes off-screen and scrolled the whole page sideways on a phone. The context now ellipsizes; the
  // label, the "1010" and the value never move.
  test('Longest wait at a long Other location: the context ellipsizes, the minutes stay in their column, no sideways scroll', async ({
    page,
  }) => {
    const where = 'TEST-dash-1 Lost and found tent behind the stereoBloom stage';
    const longestWait = { ...mockStats().longestWait, reportingLocation: 'Other', otherLocation: where, postShort: where };
    await routeStats(page, mockStats({ longestWait }));
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/?dashboard=1');
    await expect(value(page, 'perf-longest-wait')).toHaveText('24m');
    await expect(page.getByTestId('perf-longest-wait-context')).toHaveText(`1010 · ${where}`);
    // Screen readers still hear the whole location.
    await expect(page.getByRole('button', { name: `Longest wait 1010 · ${where} 24m. Request 1010 at ${where} has been waiting 24 minutes. Opens the request.` })).toBeVisible();

    for (const size of [
      { width: 375, height: 812 },
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1100, height: 800 },
    ]) {
      await page.setViewportSize(size);
      const m = await page.evaluate(() => {
        const get = (id: string) => {
          const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
          if (!el) throw new Error(`no ${id}`);
          return el;
        };
        // The y of an element's text baseline: a zero-size inline-block sits on it.
        const baseline = (el: HTMLElement) => {
          const probe = document.createElement('span');
          probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
          el.appendChild(probe);
          const y = probe.getBoundingClientRect().bottom;
          probe.remove();
          return y;
        };
        const ctx = get('perf-longest-wait-context');
        const label = ctx.previousElementSibling as HTMLElement;
        const value = get('perf-longest-wait-value');
        const digits = value.firstElementChild as HTMLElement;
        const r = (el: HTMLElement) => el.getBoundingClientRect();
        return {
          vw: document.documentElement.clientWidth,
          hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          row: r(get('perf-longest-wait')).right,
          label: { right: r(label).right, cut: label.scrollWidth > label.clientWidth + 1 },
          ctx: { left: r(ctx).left, right: r(ctx).right, cut: ctx.scrollWidth > ctx.clientWidth + 1, overflow: getComputedStyle(ctx).textOverflow },
          value: { left: r(value).left, right: r(value).right, cut: value.scrollWidth > value.clientWidth + 1 },
          // Time to reunite sits in the same column as Longest wait at every width.
          sameColumnValueRight: r(get('perf-reunite-value')).right,
          baselines: { label: baseline(label), ctx: baseline(ctx), digits: baseline(digits) },
        };
      });
      const at = `${size.width}x${size.height}`;
      expect(m.hScroll, at).toBe(false);
      expect(m.value.right, at).toBeLessThanOrEqual(m.vw - 16);
      expect(m.value.right, at).toBeLessThanOrEqual(m.row + 0.5);
      expect(Math.abs(m.value.right - m.sameColumnValueRight), at).toBeLessThanOrEqual(0.5);
      expect(m.value.cut, at).toBe(false);
      expect(m.label.cut, at).toBe(false);
      expect(m.ctx.left, at).toBeGreaterThanOrEqual(m.label.right);
      expect(m.ctx.right, at).toBeLessThanOrEqual(m.value.left);
      expect(m.ctx.cut, at).toBe(true);
      expect(m.ctx.overflow, at).toBe('ellipsis');
      // Label, context and digits still share one baseline.
      expect(Math.abs(m.baselines.ctx - m.baselines.label), at).toBeLessThanOrEqual(1);
      expect(Math.abs(m.baselines.digits - m.baselines.label), at).toBeLessThanOrEqual(1);
    }

    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByTestId('perf-longest-wait').click();
    await expect(page).toHaveURL(/\?r=5eed0000-0000-4000-8000-000000001010$/);
  });

  // The desk (from 768 px, components/desk): the dashboard sits in the shell's main column and follows its
  // width (v7-laptop.png). Six tiles in one row from 1024 px with room, else 3 × 2 (open statuses over closed
  // ones); every value in a row on one line; posts beside recent and Performance in two columns with room,
  // stacked when a request docks beside it.
  const TILE_ORDER = ['tile-open', 'tile-waiting', 'tile-in-medical', 'tile-closed', 'tile-not-in-medical', 'tile-reunited'];
  const VALUE_IDS = ['open-count', 'tile-waiting-value', 'tile-in-medical-value', 'tile-closed-value', 'tile-not-in-medical-value', 'tile-reunited-value'];
  const hScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

  test('768 px and wider: in the desk column, six tiles in one row or 3 × 2, values on one line, posts beside recent, two-column performance', async ({ page }) => {
    await routeStats(page, mockStats());
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto('/?dashboard=1');
    await expect(page.getByTestId('open-count')).toHaveText('7');
    await expect(page.getByTestId('desk-rail')).toBeVisible();
    // The shell's top bar is the title: one h1, no Back, and the live line beside it (live-indicator.html,
    // Desktop frame): the last stats fetch in minutes and Refresh now. One line on the page; no chip.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
    await expect(page.getByRole('button', { name: 'Back to requests' })).toHaveCount(0);
    const line = page.getByTestId('desk-topbar').getByTestId('live-indicator');
    await expect(line).toHaveAttribute('data-state', 'healthy');
    await expect(line.getByTestId('live-text')).toHaveText('Updated just now');
    await expect(line).toContainText('Dashboard updated just now.');
    await expect(line.getByRole('button', { name: 'Refresh now', exact: true })).toBeVisible();
    await expect(page.getByTestId('live-indicator')).toHaveCount(1);
    await expect(page.getByTestId('dashboard-connection')).toHaveCount(0);
    await expect(page.getByTestId('connection-banner')).toHaveCount(0);
    // The tiles start where the top bar's title does.
    const title = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
    expect(Math.abs((await box(page, 'tile-open')).x - Math.round(title.x))).toBeLessThanOrEqual(1);

    // 1100 px (a 1040 px column): six in one row, values on one line, the split bar and Reunited's
    // "+1 discharged · 1 cancelled" under them.
    let boxes = await Promise.all(TILE_ORDER.map((id) => box(page, id)));
    for (const b of boxes) expect(b.y).toBe(boxes[0]?.y);
    for (let i = 1; i < boxes.length; i += 1) expect(boxes[i]?.x).toBeGreaterThan(boxes[i - 1]?.x ?? Infinity);
    let values = await Promise.all(VALUE_IDS.map((id) => box(page, id)));
    for (const v of values) expect(Math.abs(v.bottom - values[0]!.bottom)).toBeLessThanOrEqual(1);
    const split = await box(page, 'open-split');
    expect(split.y).toBeGreaterThanOrEqual(values[0]!.bottom);
    expect(split.right - split.x).toBeGreaterThan(100);
    expect((await box(page, 'reunited-sub')).y).toBeGreaterThanOrEqual(values[5]!.bottom);
    const posts = await regionBox(page, 'Open by post');
    const recent = await regionBox(page, 'Recently updated');
    expect(Math.round(recent.y)).toBe(Math.round(posts.y));
    expect(recent.x).toBeGreaterThan(posts.x + posts.width);
    const longest = await box(page, 'perf-longest-wait');
    const answer = await box(page, 'perf-answer');
    expect(answer.y).toBe(longest.y);
    expect(answer.x).toBeGreaterThan(longest.right);

    // iPad portrait: 3 × 2, Open / Waiting / In medical over Closed / Not found in medical / Reunited, each row's
    // values on one line; posts still beside recent.
    for (const width of [820, 768]) {
      await page.setViewportSize({ width, height: 1024 });
      await expect.poll(async () => (await box(page, 'tile-closed')).y, `${width}`).toBeGreaterThan((await box(page, 'tile-open')).y);
      boxes = await Promise.all(TILE_ORDER.map((id) => box(page, id)));
      values = await Promise.all(VALUE_IDS.map((id) => box(page, id)));
      for (const row of [boxes.slice(0, 3), boxes.slice(3)]) for (const b of row) expect(b.y, `${width}`).toBe(row[0]!.y);
      expect(boxes[3]!.y, `${width}`).toBeGreaterThan(boxes[0]!.bottom);
      for (const i of [1, 2]) expect(boxes[i]!.x, `${width}`).toBeGreaterThan(boxes[i - 1]!.x);
      expect(boxes[3]!.x, `${width}`).toBe(boxes[0]!.x);
      for (const row of [values.slice(0, 3), values.slice(3)]) for (const v of row) expect(Math.abs(v.bottom - row[0]!.bottom), `${width}`).toBeLessThanOrEqual(1);
      const p = await regionBox(page, 'Open by post');
      const r = await regionBox(page, 'Recently updated');
      expect(Math.round(r.y), `${width}`).toBe(Math.round(p.y));
      expect(await hScroll(page), `${width}`).toBe(false);
    }
  });

  test('desk: with a request docked beside it the dashboard narrows (3 × 2, sections stacked); offline, the line beside the title and the banner', async ({ page, context }) => {
    await routeStats(page, mockStats());
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/?dashboard=1');
    await expect(page.getByTestId('open-count')).toHaveText('7');
    // Six in a row while nothing is open (a 964 px column).
    let boxes = await Promise.all(TILE_ORDER.map((id) => box(page, id)));
    for (const b of boxes) expect(b.y).toBe(boxes[0]!.y);

    // Longest wait opens its request in the pane: the column is 544 px now.
    await page.getByTestId('perf-longest-wait').click();
    await expect(page.getByTestId('desk-pane')).toBeVisible();
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect.poll(async () => (await box(page, 'tile-closed')).y).toBeGreaterThan((await box(page, 'tile-open')).bottom);
    boxes = await Promise.all(TILE_ORDER.map((id) => box(page, id)));
    for (const row of [boxes.slice(0, 3), boxes.slice(3)]) for (const b of row) expect(b.y).toBe(row[0]!.y);
    const posts = await regionBox(page, 'Open by post');
    const recent = await regionBox(page, 'Recently updated');
    expect(recent.y).toBeGreaterThan(posts.y + posts.height - 1);
    const longest = await box(page, 'perf-longest-wait');
    const answer = await box(page, 'perf-answer');
    expect(answer.y).toBeGreaterThan(longest.y);
    // Nothing in the column runs under the pane.
    const pane = (await page.getByTestId('desk-pane').boundingBox())!;
    for (const id of TILE_ORDER) expect((await box(page, id)).right).toBeLessThanOrEqual(Math.round(pane.x));
    expect(await hScroll(page)).toBe(false);

    // Offline (F1.2): the gray banner at the top of the column, and the line beside the title shows the last
    // good time with a gray dot; the numbers stay. Back online, the line is healthy again.
    const line = page.getByTestId('desk-topbar').getByTestId('live-indicator');
    await context.setOffline(true);
    try {
      await expect(line).toHaveAttribute('data-state', 'offline', { timeout: 15_000 });
      await expect(line.getByTestId('live-text')).toHaveText(/^Last updated \d{1,2}:\d{2} (AM|PM)$/);
      await expect(page.getByTestId('dashboard').getByTestId('connection-banner')).toHaveText(/^Offline · \d+ waiting to send$/);
      const t = (await page.getByTestId('desk-topbar').getByRole('heading', { level: 1 }).boundingBox())!;
      const c = (await line.boundingBox())!;
      expect(c.x).toBeGreaterThan(t.x + t.width - 1);
      expect(c.x).toBeLessThan(t.x + t.width + 24);
      // The line never runs under the search icon or New request.
      expect(c.x + c.width).toBeLessThanOrEqual((await page.getByTestId('desk-new').boundingBox())!.x);
      await expect(page.getByTestId('open-count')).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
    await expect(line).toHaveAttribute('data-state', 'healthy', { timeout: 20_000 });
    await expect(page.getByTestId('connection-banner')).toHaveCount(0);
  });

  test('desk: the top bar\'s line follows the lists\' thresholds with the banner (one failed stats fetch shows nothing; the 3rd server error is Reconnecting)', async ({ page }) => {
    await routeStats(page, mockStats());
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/?dashboard=1');
    await expect(page.getByTestId('open-count')).toHaveText('7');
    const line = page.getByTestId('desk-topbar').getByTestId('live-indicator');
    const refresh = line.getByRole('button', { name: 'Refresh now', exact: true });
    const banner = page.getByTestId('dashboard').getByTestId('connection-banner');
    await expect(line).toHaveAttribute('data-state', 'healthy');
    await page.unroute('**/api/stats');
    await page.route('**/api/stats', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"unavailable","message":"Try again"}}' }));
    // One failed fetch: the line and the banner both stay as they were (they read the same `failing`).
    await refresh.click();
    await expect(refresh).not.toHaveAttribute('data-refreshing', { timeout: 10_000 });
    await expect(line).toHaveAttribute('data-state', 'healthy');
    await expect(line.getByTestId('live-text')).toHaveText('Updated just now');
    await expect(page.getByTestId('connection-banner')).toHaveCount(0);
    // The 3rd server error in a row: Reconnecting in the top bar and the amber banner together.
    for (let i = 0; i < 2; i += 1) {
      await refresh.click();
      await expect(refresh).not.toHaveAttribute('data-refreshing', { timeout: 10_000 });
    }
    await expect(line).toHaveAttribute('data-state', 'reconnecting');
    await expect(line.getByTestId('live-text')).toHaveText(/^Last updated \d{1,2}:\d{2} (AM|PM)$/);
    await expect(banner).toHaveText('Reconnecting…');
    // Stats back: one Refresh now clears both.
    await page.unroute('**/api/stats');
    await routeStats(page, mockStats());
    await refresh.click();
    await expect(line).toHaveAttribute('data-state', 'healthy', { timeout: 15_000 });
    await expect(page.getByTestId('connection-banner')).toHaveCount(0);
  });
});
