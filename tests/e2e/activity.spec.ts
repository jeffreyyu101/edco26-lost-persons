import { randomUUID } from 'node:crypto';
import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { OVERFLOW_WIDTHS, expectNoOverflow } from './helpers/overflow';
import { newSignedInContext, signedInAs } from './helpers/session';

// The Activity inbox (F4, design/screens/f34-states.html, f34-v2-1..4 and 9): the bell with its count next to
// search, the phone's full-height sheet and the desk's popover (and sidebar item), one row per request, a row
// opens the request and marks it read (opening the sheet does not), Mark all read with Undo, "Nothing new".
// Another phone (the liaison) answers synthetic requests (TEST-F4V-<tag>) through the API; closed afterwards.

const BASE = testBaseUrl();
const FRONT = { staffName: 'TEST-F4 Activity Front', team: 'GC/HX - Dispatch' };
const LIAISON = { staffName: 'TEST-F4 Activity Liaison', team: 'Medical' };
const TAG = `TEST-F4V-${Date.now().toString(36)}`;
let seq = 0;

signedInAs(FRONT);

const bell = (page: Page) => page.getByTestId('activity-bell').filter({ visible: true });

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  // A list, an empty view or the desk table: the view's root is there.
  await expect(page.locator('[data-view], [data-testid="desk-table-view"]').first()).toBeVisible({ timeout: 15_000 });
}

/** Every Activity row of this identity read, so the bell counts only this test's events. */
async function clearActivity(ctx: BrowserContext): Promise<void> {
  const res = await ctx.request.post('/api/activity/read', { headers: { origin: BASE }, data: { all: true } });
  expect(res.status()).toBe(200);
}

async function log(front: BrowserContext, name: string, created: RequestSummary[]): Promise<RequestSummary> {
  seq += 1;
  const res = await front.request.post('/api/requests', {
    headers: { origin: BASE },
    data: { clientMutationId: randomUUID(), reportingLocation: 'FA 4 – Oasis', name: `${name} ${TAG}${seq}`, age: '24', gender: 'Male', contactPhone: '407-555-0100' },
  });
  expect(res.status(), await res.text()).toBe(201);
  const r = ((await res.json()) as { request: RequestSummary }).request;
  created.push(r);
  return r;
}

async function answer(liaison: BrowserContext, r: RequestSummary, status = 'Found – Awaiting Reunion'): Promise<RequestSummary> {
  const current = ((await (await liaison.request.get(`/api/sync?ids=${r.id}`)).json()) as { rows: RequestSummary[] }).rows[0] ?? r;
  const res = await liaison.request.post(`/api/requests/${r.id}/status`, { headers: { origin: BASE }, data: { status, expectedVersion: current.rowVersion, kind: 'answer' } });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { request: RequestSummary }).request;
}

async function closeAll(liaison: BrowserContext, created: RequestSummary[]): Promise<void> {
  for (const r of created.splice(0)) {
    try {
      const row = ((await (await liaison.request.get(`/api/sync?ids=${r.id}`)).json()) as { rows: RequestSummary[] }).rows[0];
      if (row && row.status === 'Found – Awaiting Reunion') {
        await liaison.request.post(`/api/requests/${r.id}/status`, { headers: { origin: BASE }, data: { status: 'Reunited – Closed', expectedVersion: row.rowVersion, kind: 'reunite' } });
      }
    } catch {
      // best effort
    }
  }
}

/** The unread count the server holds for this identity (activityUnread on sync). */
async function serverUnread(ctx: BrowserContext): Promise<number> {
  const body = (await (await ctx.request.get('/api/sync?limit=1')).json()) as { activityUnread?: number };
  return body.activityUnread ?? -1;
}

test.describe('phone', () => {
  test('the bell counts unread requests; the sheet lists one row per request; a row opens it and marks it read', async ({ page, context, browser }) => {
    test.slow();
    const liaison = await newSignedInContext(browser, LIAISON, { baseURL: BASE });
    const created: RequestSummary[] = [];
    try {
      await clearActivity(context);
      await openApp(page);
      await expect(bell(page)).toHaveAccessibleName('Activity');
      await expect(page.getByTestId('activity-badge')).toHaveCount(0);

      const a = await log(context, 'Ava Lane', created);
      const b = await log(context, 'Ben Wu', created);
      await answer(liaison, a);
      await answer(liaison, b);
      await expect(bell(page)).toHaveAccessibleName('Activity, 2 unread', { timeout: 20_000 });
      await expect(page.getByTestId('activity-badge')).toHaveText('2');

      await bell(page).click();
      const sheet = page.getByRole('dialog', { name: 'Activity' });
      await expect(sheet).toBeVisible();
      const rows = sheet.getByTestId('activity-row');
      // This identity is reused across runs: older rows are there too, read. Exactly this test's two are unread.
      await expect(sheet.getByRole('button', { name: /Unread\.$/ })).toHaveCount(2);
      // Newest first, initials only, the detail in nouns, the time; unread rows have the dot.
      await expect(rows.nth(0)).toContainText('B.T.');
      await expect(rows.nth(0)).toContainText('In medical');
      await expect(rows.nth(0)).toContainText('now');
      await expect(rows.nth(0)).toHaveAccessibleName(/^Request B T, answer: In medical\. .*Unread\.$/);
      await expect(sheet).not.toContainText('LP-');
      await expect(sheet).not.toContainText('555');
      // Opening the sheet marks nothing read.
      expect(await serverUnread(context)).toBe(2);

      await rows.nth(1).click();
      await expect(sheet).toHaveCount(0);
      await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(a.id);
      await expect.poll(() => serverUnread(context)).toBe(1);
      await page.goBack();
      await expect(bell(page)).toHaveAccessibleName('Activity, 1 unread', { timeout: 10_000 });
      await bell(page).click();
      await expect(page.getByRole('dialog', { name: 'Activity' }).getByTestId('activity-row').nth(1)).not.toHaveAccessibleName(/Unread\.$/);
      await page.keyboard.press('Escape');

      // Opened from anywhere (here a deep link) also marks it read.
      await page.goto(`/?r=${b.id}`);
      await expect.poll(() => serverUnread(context)).toBe(0);
    } finally {
      await closeAll(liaison, created);
      await liaison.close();
    }
  });

  test('Mark all read → "2 marked read · Undo" → Undo brings them back', async ({ page, context, browser }) => {
    test.slow();
    const liaison = await newSignedInContext(browser, LIAISON, { baseURL: BASE });
    const created: RequestSummary[] = [];
    try {
      await clearActivity(context);
      await openApp(page);
      const a = await log(context, 'Cy Diaz', created);
      const b = await log(context, 'Dee Park', created);
      await answer(liaison, a);
      await answer(liaison, b);
      await expect(bell(page)).toHaveAccessibleName('Activity, 2 unread', { timeout: 20_000 });
      await bell(page).click();
      const sheet = page.getByRole('dialog', { name: 'Activity' });
      const markAll = sheet.getByRole('button', { name: 'Mark all read' });
      await expect(markAll).toBeEnabled();
      await markAll.click();
      const undo = sheet.getByTestId('activity-undo');
      await expect(undo).toContainText('2 marked read');
      await expect(markAll).toBeDisabled();
      // (The sheet is modal: the page behind it is hidden from screen readers, so the label is read directly.)
      await expect(bell(page)).toHaveAttribute('aria-label', 'Activity');
      // The rows stay, read.
      await expect(sheet.getByRole('button', { name: /Unread\.$/ })).toHaveCount(0);
      await expect(sheet.getByTestId('activity-row').nth(1)).toBeVisible();
      await undo.getByRole('button', { name: 'Undo' }).click();
      await expect(bell(page)).toHaveAttribute('aria-label', 'Activity, 2 unread');
      await expect.poll(() => serverUnread(context)).toBe(2);
      await markAll.click();
      // The Undo bar goes after 5 s.
      await expect(sheet.getByTestId('activity-undo')).toHaveCount(0, { timeout: 8_000 });
      expect(await serverUnread(context)).toBe(0);
    } finally {
      await closeAll(liaison, created);
      await liaison.close();
    }
  });

  test('nothing yet: "Nothing new", no Mark all read', async ({ browser }) => {
    const fresh = await newSignedInContext(browser, { staffName: `TEST-F4 Empty ${Date.now().toString(36)}`, team: 'GC/HX - Base' }, { baseURL: BASE, ...devices['iPhone 14'] });
    try {
      const page = await fresh.newPage();
      await openApp(page);
      await bell(page).click();
      const sheet = page.getByRole('dialog', { name: 'Activity' });
      await expect(sheet.getByTestId('activity-empty')).toHaveText('Nothing new');
      await expect(sheet.getByRole('button', { name: 'Mark all read' })).toHaveCount(0);
    } finally {
      await fresh.close();
    }
  });
});

async function desk(browser: Browser, width = 1440): Promise<BrowserContext> {
  const d = devices['Desktop Chrome'];
  return newSignedInContext(browser, FRONT, { baseURL: BASE, viewport: { width, height: 900 }, userAgent: d.userAgent, isMobile: false, hasTouch: false });
}

test.describe('desk', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'The desk is checked in Chromium.');

  test('the top-bar bell and the sidebar item share the count; the popover opens from either; a row opens the request beside the list', async ({ browser }) => {
    test.slow();
    const ctx = await desk(browser);
    const liaison = await newSignedInContext(browser, LIAISON, { baseURL: BASE });
    const created: RequestSummary[] = [];
    try {
      await clearActivity(ctx);
      const page = await ctx.newPage();
      await openApp(page);
      const r = await log(ctx, 'Eli Moss', created);
      await answer(liaison, r);
      const top = page.getByTestId('desk-topbar').getByTestId('activity-bell');
      await expect(top).toHaveAccessibleName('Activity, 1 unread', { timeout: 20_000 });
      const side = page.getByTestId('desk-activity');
      await expect(side).toHaveAccessibleName('Activity, 1 unread');
      await expect(side).toContainText('1');

      await side.click();
      const pop = page.getByTestId('activity-popover');
      await expect(pop).toBeVisible();
      const box = await pop.boundingBox();
      expect(box?.width).toBe(380);
      expect(box?.height ?? 0).toBeLessThanOrEqual(480);
      await page.keyboard.press('Escape');
      await expect(pop).toHaveCount(0);

      await top.click();
      await expect(pop).toBeVisible();
      await pop.getByTestId('activity-row').first().click();
      await expect(pop).toHaveCount(0);
      await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(r.id);
      await expect(top).toHaveAccessibleName('Activity', { timeout: 10_000 });
    } finally {
      await closeAll(liaison, created);
      await liaison.close();
      await ctx.close();
    }
  });
});

test.describe('overflow: the Activity sheet and popover at every width', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Layout is checked once, in Chromium.');

  test('every width, with long details', async ({ browser }) => {
    test.slow();
    const liaison = await newSignedInContext(browser, LIAISON, { baseURL: BASE });
    const seed = await newSignedInContext(browser, FRONT, { baseURL: BASE });
    const created: RequestSummary[] = [];
    try {
      const r = await log(seed, 'Fay Gold', created);
      await answer(liaison, r);
      // A long location: line 2 must cut with an ellipsis, never push the time out.
      const row = ((await (await liaison.request.get(`/api/sync?ids=${r.id}`)).json()) as { rows: RequestSummary[] }).rows[0] as RequestSummary;
      await liaison.request.patch(`/api/requests/${r.id}`, { headers: { origin: BASE }, data: { patch: { medicalLocation: 'Main Med tent B, bay 14, next to the blue curtain' }, expectedVersion: row.rowVersion } });
      for (const width of OVERFLOW_WIDTHS) {
        const phone = width < 768;
        const ctx = phone
          ? await newSignedInContext(browser, FRONT, { baseURL: BASE, ...devices['iPhone 14'], viewport: { width, height: 844 } })
          : await desk(browser, width);
        try {
          const page = await ctx.newPage();
          await openApp(page);
          await expectNoOverflow(page, bell(page), 'bell');
          await bell(page).click();
          const panel = phone ? page.getByTestId('activity-sheet') : page.getByTestId('activity-popover');
          await expect(panel.getByTestId('activity-row').first()).toBeVisible({ timeout: 15_000 });
          await expectNoOverflow(page, panel, phone ? 'Activity sheet' : 'Activity popover');
        } finally {
          await ctx.close();
        }
      }
    } finally {
      await closeAll(liaison, created);
      await liaison.close();
      await seed.close();
    }
  });
});
