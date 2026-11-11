// Dashboard v4 (design/screens/dashboard-v4.html) against the seeded local stack: the status bar and legend open the
// lists they count, a Needs attention row opens its request, the range control asks the server for that range (with
// the same range on the next poll), the calls views and table, the speed hover card on tap, no polling while hidden,
// the Reconnecting banner, and the phone and desk layouts. Synthetic data only.
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { CreateResponse, RequestDetail } from '../../lib/api-types';
import { signedInAs } from './helpers/session';

const FRONT = { staffName: 'TEST-P Dashboard', team: 'GC/HX - Base' };

signedInAs(FRONT);

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function createRequest(page: Page, origin: string): Promise<string> {
  const res = await page.request.fetch('/api/requests', {
    method: 'POST',
    headers: { Origin: origin },
    data: { clientMutationId: randomUUID(), reportingLocation: 'FA 4 – Oasis', name: `TEST-P-D${Date.now().toString(36)}`, age: '22', gender: 'Male', clothing: 'Yellow raincoat' },
  });
  expect(res.ok()).toBe(true);
  const { request } = (await res.json()) as CreateResponse;
  created.push({ id: request.id, request: page.request });
  return request.id;
}

test.afterEach(async ({ baseURL }) => {
  for (const { id, request } of created.splice(0)) {
    try {
      const row = (await (await request.fetch(`/api/requests/${id}`)).json()) as RequestDetail;
      if (row.status === 'Added') await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: baseURL as string } });
    } catch {
      // Best effort.
    }
  }
});

const statsUrls = (page: Page) => {
  const urls: Array<{ url: string; etag: string | null }> = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/stats')) urls.push({ url: r.url(), etag: r.headers()['if-none-match'] ?? null });
  });
  return urls;
};
const hScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
const n = async (page: Page, id: string) => Number(await page.getByTestId(id).locator('b').innerText());

test('status: Open is Waiting + Pending + Located; the legend opens the lists; a Needs attention row opens its request', async ({ page, baseURL }) => {
  await createRequest(page, baseURL as string);
  await page.goto('/?dashboard=1');
  await expect(page.getByTestId('open-count')).toBeVisible();
  const open = Number(await page.getByTestId('open-count').innerText());
  expect(open).toBe((await n(page, 'status-waiting')) + (await n(page, 'status-pending')) + (await n(page, 'status-located')));
  expect(open).toBeGreaterThan(0);

  await page.getByTestId('status-waiting').click();
  await expect(page).toHaveURL(/status=Added/);
  await page.goBack();
  await page.getByTestId('status-located').click();
  await expect(page).toHaveURL(/status=Found/);
  await page.goBack();

  const row = page.getByTestId('attention-row').first();
  await expect(row).toBeVisible();
  await expect(row).toHaveAccessibleName(/^Request \d+ at [^,]+, (waiting|re-check|located)/);
  // The timer pill always carries a glyph with its colour.
  await expect(row.locator('[data-sev] svg').first()).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(/[?&]r=[0-9a-f-]{36}/);
});

test('range: Today (the show day) by default; a choice asks the server for that range and is remembered; the next poll asks for it again', async ({ page }) => {
  test.slow();
  const urls = statsUrls(page);
  await page.goto('/?dashboard=1');
  await expect(page.getByTestId('calls-total')).toBeVisible();
  const range = page.getByRole('radiogroup', { name: 'Time range' });
  // (Events) Today: the event's show day (from its day-start hour, in its time zone).
  await expect(range.getByRole('radio', { name: 'Today' })).toHaveAttribute('aria-checked', 'true');
  await expect(range.getByRole('radio', { name: 'Tonight' })).toHaveCount(0);
  expect(urls.at(-1)!.url).toContain('range=today');

  await range.getByRole('radio', { name: '1h' }).click();
  await expect.poll(() => urls.some((u) => u.url.includes('range=1h'))).toBe(true);
  await expect(page.locator('[data-range="1h"]')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('radiogroup', { name: 'Time range' }).getByRole('radio', { name: '1h' })).toHaveAttribute('aria-checked', 'true');

  // The next poll (15 s) asks for the same range again, through the store's session-safe fetch.
  const before = urls.length;
  await expect.poll(() => urls.slice(before).some((u) => u.url.includes('range=1h')), { timeout: 25_000 }).toBe(true);
});

test('calls: Total bars, By post with its legend (the range\'s posts), the Heatmap, and the same numbers as a table', async ({ page }) => {
  await page.goto('/?dashboard=1');
  const calls = page.getByTestId('calls');
  await expect(calls.getByRole('img', { name: /^Calls per 15 minutes/ })).toBeVisible();
  const view = page.getByRole('radiogroup', { name: 'Calls view' });
  await expect(view.getByRole('radio', { name: 'By tent' })).toHaveCount(0);
  await view.getByRole('radio', { name: 'By post' }).click();
  await expect(calls.getByRole('img', { name: /stacked by post/ })).toBeVisible();
  // (Events) The legend is the range's posts as the server ordered them (the four busiest, then Other).
  const stats = (await (await page.request.get('/api/stats?range=today')).json()) as { range: { posts: Array<{ post: string }> } };
  for (const { post } of stats.range.posts) await expect(calls.getByText(post, { exact: true }).first()).toBeVisible();
  await view.getByRole('radio', { name: 'Heatmap' }).click();
  await expect(page.getByTestId('heat-chart').getByRole('img', { name: /^Calls by (hour|15 minutes) and post/ })).toBeVisible();
  await page.getByTestId('calls-table-toggle').click();
  await expect(calls.locator('table')).toBeVisible();
  await expect(calls.locator('th').first()).toHaveText('Post');
  await view.getByRole('radio', { name: 'Total' }).click();
});

test('speed: a tap opens the details (p90, target, per tent, sparkline)', async ({ page }) => {
  await page.goto('/?dashboard=1');
  const col = page.getByTestId('speed-firstCheck');
  await expect(col).toHaveAccessibleName(/^First check: (median [\d.]+ minutes, (under|over) the 10 minute target\. Details|no data in range)$/);
  await col.click();
  const card = page.getByRole('dialog', { name: 'First check details' }).or(page.locator('[aria-label="First check details"]'));
  await expect(card).toBeVisible();
  await expect(card).toContainText('p90');
  await expect(card).toContainText('Target');
  await expect(card).toContainText('10m');
});

test('hidden: no poll goes out while the page is hidden; shown again, one at once', async ({ page }) => {
  test.slow();
  const urls = statsUrls(page);
  await page.goto('/?dashboard=1');
  await expect(page.getByTestId('calls-total')).toBeVisible();
  const flip = (hidden: boolean) =>
    page.evaluate((h) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  await flip(true);
  const before = urls.length;
  await page.waitForTimeout(17_000);
  expect(urls.length).toBe(before);
  await flip(false);
  await expect.poll(() => urls.length).toBe(before + 1);
});

test('offline: the Reconnecting / Offline banner; back online it goes', async ({ page, context }) => {
  await page.goto('/?dashboard=1');
  await expect(page.getByTestId('calls-total')).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 20_000 });
  await context.setOffline(false);
  await expect(page.getByTestId('connection-banner')).toHaveCount(0, { timeout: 30_000 });
});

test('phone: ‹ Dashboard with who is on, the range under it, one column in order, timers tick, no sideways scroll', async ({ page }) => {
  await page.goto('/?dashboard=1');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  // (Events) Who's on names the event's teams (their short names) in its setup order.
  await expect(page.getByTestId('who')).toHaveAccessibleName(/^\d+ people on in the last 10 minutes: GCHX Med Transpo [^,]+, Dispatch [^,]+, GCHX Base [^,]+, Medical /);
  const ys = [];
  for (const id of ['status', 'attention', 'speed', 'calls', 'recap']) ys.push((await page.getByTestId(id).boundingBox())!.y);
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  expect(await hScroll(page)).toBe(false);
  const timer = page.getByTestId('attention-row').first().locator('[data-sev]');
  if (await timer.count()) {
    const t0 = await timer.innerText();
    await expect.poll(() => timer.innerText(), { timeout: 4_000 }).not.toBe(t0);
  }
  // No helper sentences on screen (the full sentences are for screen readers only): labels and values.
  const visible = await page.getByTestId('dashboard').evaluate((root) => {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let out = '';
    while (walk.nextNode()) {
      const r = walk.currentNode.parentElement!.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) out += `${walk.currentNode.textContent} `;
    }
    return out;
  });
  expect(visible).not.toMatch(/Updated|minutes ago|last 2 hours|Show them/);
});

test('desk (1440 × 900): status across, Needs attention and Speed beside Calls; who is on and the range in the top bar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?dashboard=1');
  await expect(page.getByTestId('calls-total')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
  await expect(page.getByRole('button', { name: 'Back to requests' })).toHaveCount(0);
  const top = page.getByTestId('desk-topbar');
  await expect(top.getByRole('radiogroup', { name: 'Time range' })).toBeVisible();
  await expect(top.getByTestId('who')).toBeVisible();
  await expect(top.getByTestId('desk-new')).toHaveCount(0);
  const b = async (id: string) => (await page.getByTestId(id).boundingBox())!;
  const [status, att, spd, calls] = [await b('status'), await b('attention'), await b('speed'), await b('calls')];
  expect(att.y).toBeGreaterThan(status.y + status.height - 1);
  expect(spd.y).toBeGreaterThan(att.y + att.height - 1);
  expect(Math.abs(spd.x - att.x)).toBeLessThan(2);
  expect(calls.x).toBeGreaterThan(att.x + att.width);
  expect(Math.abs(calls.y - att.y)).toBeLessThan(2);
  expect(Math.abs(calls.y + calls.height - (spd.y + spd.height))).toBeLessThan(2);
  expect(calls.height).toBeGreaterThan(500);
  expect(await hScroll(page)).toBe(false);
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
