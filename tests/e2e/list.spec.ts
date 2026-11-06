import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { RequestDetail, RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { syntheticPng } from './helpers/png';
import { newSignedInContext, signedInAs } from './helpers/session';
import { syncRows } from './helpers/sync';

// List views end to end (spec §8 List views, §9.4 "it appears in All and My requests", "a second context
// sees it in Pending … taps In medical", "Friend coming → Reunited", "undo", "search", "a tile filtering
// All"). Runs against the real store and API on the local stack. Every row is synthetic and unique to this
// run (TEST-L-<tag>); nothing is truncated or reset.

const BASE = testBaseUrl();
const STAFF = { staffName: 'TEST-L Lists', team: 'Medical' };
const TAG = `TEST-L-${Date.now().toString(36)}`;
let seq = 0;

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
  return ((await res.json()) as { request: RequestSummary }).request;
}

const row = (page: Page, id: string) => page.locator(`[data-request-id="${id}"]`);
const checkCard = (page: Page, id: string) => page.locator(`[data-testid="check-card"]:has([data-request-id="${id}"])`);
const comingCard = (page: Page, id: string) => page.locator(`[data-testid="friend-coming-card"]:has([data-request-id="${id}"])`);
const lp = (r: RequestSummary) => `LP-${String(r.caseNumber).padStart(4, '0')}`;

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

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('All: a new request is on top with its status, post and LP number, and opens the profile', async ({ page }) => {
  const r = await createRequest(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Is my friend in medical?' })).toBeVisible();
  await expect(row(page, r.id)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="request-list"] [data-request-id]').first()).toHaveAttribute('data-request-id', r.id);
  await expect(row(page, r.id)).toContainText('Waiting for check');
  await expect(row(page, r.id)).toContainText(`FA 3 · ${lp(r)}`);
  await expect(row(page, r.id)).toContainText('21 F');
  await expect(page.getByText('Newest first')).toBeVisible();
  await row(page, r.id).click();
  await expect(page).toHaveURL(new RegExp(`\\?r=${r.id}$`));
});

test('view switcher: Pending and My requests with counts, × returns to All', async ({ page }) => {
  const r = await createRequest(page);
  await page.goto('/');
  await expect(row(page, r.id)).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('view-switcher').click();
  await expect(page.getByRole('menuitemradio', { name: /^All requests \d+$/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemradio', { name: /^My requests \d+$/ })).toBeVisible();
  await page.getByRole('menuitemradio', { name: /^Pending \d+$/ }).click();
  await expect(page).toHaveURL(/\?view=pending$/);
  await expect(checkCard(page, r.id)).toBeVisible();
  await expect(checkCard(page, r.id)).toContainText(`${lp(r)} · FA 3`);
  await expect(page.getByRole('button', { name: /^Pending \d+, change view$/ })).toBeVisible();

  await page.getByRole('button', { name: 'Back to all requests' }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.getByTestId('view-switcher').click();
  await page.getByRole('menuitemradio', { name: /^My requests \d+$/ }).click();
  await expect(page).toHaveURL(/\?view=mine$/);
  const card = page.locator(`[data-testid="mine-card"]:has([data-request-id="${r.id}"])`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Waiting for check');
  await expect(card).toContainText('Logged');
});

test('Pending: In medical → Friend coming, Undo, then Reunited closes it (dimmed in All)', async ({ page }) => {
  const r = await createRequest(page);
  await page.goto('/?view=pending');
  await expect(checkCard(page, r.id)).toBeVisible({ timeout: 10_000 });

  await checkCard(page, r.id).getByRole('button', { name: 'In medical', exact: true }).click();
  await expect(comingCard(page, r.id)).toBeVisible();
  await expect(comingCard(page, r.id)).toContainText(`${TAG} Friend · from FA 3`);
  await expect(checkCard(page, r.id)).toHaveCount(0);

  await expect(page.getByText(`${lp(r)} · In medical`)).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(checkCard(page, r.id)).toBeVisible();
  await expect(comingCard(page, r.id)).toHaveCount(0);

  await checkCard(page, r.id).getByRole('button', { name: 'In medical', exact: true }).click();
  await expect(comingCard(page, r.id)).toBeVisible();
  await comingCard(page, r.id).getByRole('button', { name: 'Reunited' }).click();
  await expect(comingCard(page, r.id)).toHaveCount(0);

  await page.getByRole('button', { name: 'Back to all requests' }).click();
  await expect(row(page, r.id)).toContainText('Reunited');
  // Closed rows are dimmed by their glyph and gray-11 text, never by row opacity (contrast, spec §7).
  await expect(row(page, r.id)).toHaveCSS('opacity', '1');
  await expect(row(page, r.id).locator(':scope > span').first()).toHaveCSS('opacity', '0.55');
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
  // Only Not in medical rows are listed.
  const labels = await page.locator('[data-testid="request-list"] [data-request-id]').allTextContents();
  expect(labels.every((t) => t.includes('Not in medical'))).toBe(true);

  await chip.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(chip).toHaveCount(0);
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
  await expect(page.getByTestId('live-dot')).toHaveAttribute('data-state', 'live', { timeout: 15_000 });

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
    await expect(checkCard(page, id!)).toContainText(`${lpText} · FA 4`);
    await checkCard(page, id!).getByRole('button', { name: 'In medical', exact: true }).click();
    await expect(comingCard(page, id!)).toBeVisible();

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

test('a request logged elsewhere shows up within one poll; tapping the live dot syncs now', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('request-list')).toBeVisible({ timeout: 10_000 });
  const r = await createRequest(page);
  const sync = page.waitForRequest((req) => req.url().includes('/api/sync'));
  await page.getByTestId('live-dot').click();
  await sync;
  await expect(row(page, r.id)).toBeVisible({ timeout: 8_000 });
});

test('offline: amber dot, banner between the header and the view bar, answers need a connection', async ({ page, context }) => {
  const r = await createRequest(page);
  await page.goto('/?view=pending');
  await expect(checkCard(page, r.id)).toBeVisible({ timeout: 10_000 });

  await context.setOffline(true);
  try {
    await expect(page.getByTestId('live-dot')).toHaveAttribute('data-state', 'off');
    // The shell may render its own copy (hidden before list views): only one is ever visible.
    const banner = page.getByText(/^Offline · \d+ waiting to send$/).filter({ visible: true });
    await expect(banner).toBeVisible();
    const header = await page.getByRole('heading', { name: 'Is my friend in medical?' }).boundingBox();
    const bannerBox = await banner.boundingBox();
    const bar = await page.getByTestId('view-switcher').boundingBox();
    expect(header && bannerBox && bar).toBeTruthy();
    expect(bannerBox!.y).toBeGreaterThan(header!.y);
    expect(bar!.y).toBeGreaterThan(bannerBox!.y);

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
  await expect(page.getByTestId('live-dot')).toHaveAttribute('data-state', /live|loading/, { timeout: 15_000 });
});
