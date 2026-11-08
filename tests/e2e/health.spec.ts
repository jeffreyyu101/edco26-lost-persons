import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { localDbUrl, testBaseUrl } from '../../scripts/test-env.mjs';
import { axeViolations } from './helpers/a11y';
import { sessionCookieHeader, signedInAs, signedInState } from './helpers/session';

// The Health page (/health, design/references/observability-design.md §5), at a laptop's 1440 × 900 in both projects:
// without a session it goes to sign-in and back; seeded rows render every panel; Refresh makes exactly one request and
// nothing polls; a phone width says Desktop only; the desk sidebar's Health link shows only on a device that opened
// /health; the switch (behind its confirm) turns collection off, and then can't turn it back on (SQL only); axe finds
// nothing.

const BASE = testBaseUrl();
const STAFF = { staffName: 'TEST-e2e Health', team: 'GC/HX - Dispatch' };
// Letters only: a stored string can't hold 4 digits in a row (lp_tel_events_no_digit_run).
const AREA = `tie${Date.now().toString(36).replace(/\d/g, (c) => 'abcdefghij'[Number(c)] ?? 'a')}`;
const DEVICE = `tie2e${Date.now().toString(36)}`.padEnd(16, '0').slice(0, 16);

test.use({ serviceWorkers: 'block', bypassCSP: true });
signedInAs(STAFF);

const psql = (sql: string) => execFileSync('psql', [localDbUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-c', sql], { encoding: 'utf8' }).trim();

test.beforeAll(() => {
  const ins = (name: string, extra: string) =>
    `insert into public.lp_tel_events (at, device, session, team, name, view, area, ctl, ms, n, props, trail) values (now(), '${DEVICE}', 'sesse2e001', 'dispatch', '${name}', ${extra});`;
  psql(
    [
      ins('stuck_scroll', `'profile', '${AREA}', null, null, 3, '{"dir":"up","edge":"top"}', '[[-2400, "v>profile"], [-900, "w!:thread:u"]]'`),
      ins('rage_tap', `'pending', '${AREA}-b', 'check-card', null, 3, '{"ptr":"touch"}', '[[-500, "t:pending-column-#/check-card"]]'`),
      ins('flow_open', `'all', null, null, 1800, null, '{"out":"ok","cache":"yes"}', null`),
      ins('net', `null, '/api/sync:delta', null, null, 12, '{"m":"get","st":"2xx","on":true,"conn":"live","d":[120,240,300]}', null`),
      ins('error', `'profile', 'chunk:e2eaaaab', 'typeerror', null, 1, '{"type":"typeerror","kind":"error","fp":"e2efp001","line":1,"col":9}', '[[-10, "e:typeerror"]]'`),
    ].join('\n'),
  );
});

test.afterAll(async () => {
  psql(`delete from public.lp_tel_events where device = '${DEVICE}'`);
  psql(`update public.lp_tel_settings set enabled = true, updated_at = now()`);
  const cookie = await sessionCookieHeader(STAFF);
  await fetch(`${BASE}/api/telemetry/settings`, { method: 'POST', headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
});

async function openHealth(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/health');
  await expect(page.getByTestId('health-kpis')).toBeVisible({ timeout: 15_000 });
}

test('without a session /health goes to sign-in, and back after it', async ({ browser }) => {
  // An explicit empty state: a context made in a test otherwise takes the file's signed-in storageState.
  const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  try {
    const page = await ctx.newPage();
    const res = await page.request.get('/health', { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()['location']).toMatch(/^\/signin\?next=(\/|%2F)health$/);
  } finally {
    await ctx.close();
  }
});

test('seeded rows render every panel; Refresh makes exactly one request; nothing polls', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const calls: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/')) calls.push(new URL(r.url()).pathname);
  });
  await openHealth(page);
  await expect(page.getByTestId('health-problem').filter({ hasText: AREA }).first()).toBeVisible();
  for (const id of ['panel-paths', 'panel-net', 'panel-push', 'panel-coverage', 'panel-errors']) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId('panel-errors')).toContainText('chunk:e2eaaaab');
  await expect(page.getByTestId('health-status')).toContainText('Collecting');
  // The trail drawer.
  await page.locator('[data-testid="health-problem"][data-signal="stuck_scroll"]').filter({ hasText: AREA }).first().getByTestId('health-trail-open').click();
  await expect(page.getByTestId('health-trail')).toBeVisible();
  await expect(page.getByTestId('health-trail')).toContainText('v>profile');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('health-trail')).toBeHidden();

  const before = calls.filter((c) => c === '/api/telemetry/health').length;
  await page.getByTestId('health-refresh').click();
  await expect.poll(() => calls.filter((c) => c === '/api/telemetry/health').length).toBe(before + 1);
  await expect(page.getByTestId('health-refresh')).toBeEnabled();
  if (testInfo.project.name === 'chromium-iphone14') {
    const settled = calls.length;
    await page.waitForTimeout(30_000);
    expect(calls.slice(settled)).toEqual([]);
  }
});

test('a phone width says Desktop only', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/health');
  await expect(page.getByTestId('health-desktop-only')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Desktop only')).toBeVisible();
});

test('the desk sidebar shows Health only on a device that opened /health', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: BASE, storageState: await signedInState(STAFF), viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.getByTestId('desk-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('desk-health')).toHaveCount(0);
    await page.goto('/health');
    await expect(page.getByTestId('health-kpis')).toBeVisible({ timeout: 15_000 });
    await page.goto('/');
    await expect(page.getByTestId('desk-health')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('desk-health')).toHaveAttribute('href', '/health');
  } finally {
    await ctx.close();
  }
});

test('the switch turns collection off behind its confirm (ingest then 204); back on is SQL only', async ({ page }) => {
  await openHealth(page);
  const sw = page.getByTestId('health-switch');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(page.getByTestId('health-confirm')).toBeVisible();
  await page.getByTestId('health-turn-off').click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('health-status')).toContainText('Off');
  expect(psql(`select enabled from public.lp_tel_settings`)).toBe('f');
  const ingest = await page.request.post('/api/telemetry', {
    headers: { origin: BASE, 'content-type': 'application/json' },
    data: { v: 1, b: 'e2eoffbatch01', d: DEVICE, s: 'sesse2e001', sent: Date.now(), ctx: { plat: 'mac', osv: 0, eng: 'blink', sa: false, lay: 'desktop', dpr: 2, touch: false, build: 'none', eff: 'na', mem: -1 }, ev: [{ n: 'view', at: Date.now() }] },
  });
  expect(ingest.status()).toBe(204);
  // Off, the switch can't be used, and the route refuses to turn it back on.
  await expect(sw).toBeDisabled();
  const on = await page.request.post('/api/telemetry/settings', { headers: { origin: BASE, 'content-type': 'application/json' }, data: { enabled: true } });
  expect(on.status()).toBe(403);
  expect(psql(`select enabled from public.lp_tel_settings`)).toBe('f');
  // Back on in SQL: the next load shows it on (the route's {enabled: true} only re-reads the settings).
  psql(`update public.lp_tel_settings set enabled = true, updated_at = now()`);
  expect((await page.request.post('/api/telemetry/settings', { headers: { origin: BASE, 'content-type': 'application/json' }, data: { enabled: true } })).status()).toBe(200);
  await page.getByTestId('health-refresh').click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(sw).toBeEnabled();
});

test('axe finds nothing on /health', async ({ page }) => {
  await openHealth(page);
  await expect(page.getByTestId('health-problem').first()).toBeVisible();
  expect((await axeViolations(page)).map((f) => `${f.rule} ${f.target} ${f.summary}`)).toEqual([]);
});
