import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { RequestDetail, RequestSummary } from '../../lib/api-types';
import { INACTIVE_MINUTES, STATUS, STATUS_META } from '../../lib/domain';
import { formatCaseNumber } from '../../lib/format';
import { localDbUrl, testBaseUrl } from '../../scripts/test-env.mjs';
import { OVERFLOW_WIDTHS, expectNoOverflow } from './helpers/overflow';
import { newSignedInContext, signedInAs, type TestStaff } from './helpers/session';

// F6 · Inactivity auto-close (Brian 2026-11-06 19:55–20:07; spec §24 A96–A103), end to end on the real store, API
// and database: a request answered In medical whose activity is backdated an hour (psql), then closed by the
// server's own lp_close_inactive (on this row only: the 5-minute job stays paused on local stacks), shows
// "Closed · inactive" (grey, the timer-off glyph, "Inactive" on a phone under 430 px) folded in Archived, and in its
// detail (the System change and its note, Reopen in the action bar); Reopen returns it to Friend coming. Then the
// overflow check at 375–1440 px: the row, the request and the dashboard's Closed · inactive tile, each one line.
// Synthetic rows only (TEST-F6-…), closed again afterwards.

const BASE = testBaseUrl();
const FOH: TestStaff = { staffName: 'TEST-F6 Front', team: 'GC/HX - Dispatch' };
const MEDIC: TestStaff = { staffName: 'TEST-F6 Medic', team: 'Medical' };
const TAG = `TEST-F6-${Date.now().toString(36)}`;
const LABEL = STATUS_META[STATUS.inactive].label;
const NARROW = STATUS_META[STATUS.inactive].narrowLabel as string;
let seq = 0;

test.use({ serviceWorkers: 'block' });
signedInAs(FOH);

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function call<T>(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function createRequest(request: APIRequestContext): Promise<RequestSummary> {
  seq += 1;
  const body = { clientMutationId: randomUUID(), reportingLocation: 'FA 3 – Kinetic', name: `${TAG} P${seq}`, age: '22', gender: 'Female' };
  const { request: row } = await call<{ request: RequestSummary }>(request, 'POST', '/api/requests', body);
  created.push({ id: row.id, request });
  return row;
}

const psql = (sql: string) =>
  execFileSync('psql', [localDbUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-c', sql], { encoding: 'utf8' }).trim();
const lit = (id: string) => `'${id.replace(/'/g, "''")}'`;

/** A request the signed-in staff logged, answered In medical by medical. */
async function answeredRequest(page: Page): Promise<RequestSummary> {
  const medic = await newSignedInContext(page.context().browser()!, MEDIC);
  try {
    const r = await createRequest(page.request);
    return (await call<{ request: RequestSummary }>(medic.request, 'POST', `/api/requests/${r.id}/status`, { status: STATUS.inMedical, expectedVersion: r.rowVersion, kind: 'answer' })).request;
  } finally {
    await medic.close();
  }
}

/** Moves the request's activity (audit rows, created_at) `minutes` into the past. */
function backdate(id: string, minutes: number): void {
  psql(
    `update public.audit_events set occurred_at = occurred_at - interval '${minutes} minutes' where patient_id = ${lit(id)};` +
      ` update public.patients set created_at = created_at - interval '${minutes} minutes' where id = ${lit(id)};`,
  );
}

/** In medical (answered by medical), an hour and a minute idle, then closed by lp_close_inactive. */
async function inactiveRequest(page: Page): Promise<RequestSummary> {
  const r = await answeredRequest(page);
  backdate(r.id, INACTIVE_MINUTES + 1);
  expect(psql(`select public.lp_close_inactive(array[${lit(r.id)}]::uuid[])`)).toBe('1');
  return call<RequestDetail>(page.request, 'GET', `/api/requests/${r.id}`);
}

/** The element's text sits on one line (never wraps). */
async function oneLine(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const style = getComputedStyle(node);
    const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.3;
    return node.getBoundingClientRect().height < line * 1.6;
  });
}

test.afterEach(async () => {
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await call<RequestDetail>(request, 'GET', `/api/requests/${id}`);
      if (row.status === STATUS.inMedical)
        await request.fetch(`/api/requests/${id}/status`, {
          method: 'POST',
          data: { status: STATUS.reunited, expectedVersion: row.rowVersion, kind: 'reunite' },
          headers: { Origin: BASE },
        });
    } catch {
      // Best effort.
    }
  }
});

test('Closed · inactive: folded in Archived, its detail with Reopen; Reopen returns it to Friend coming', async ({ page }) => {
  test.setTimeout(90_000);
  const r = await inactiveRequest(page);
  expect(r).toMatchObject({ status: STATUS.inactive, updatedBy: 'System' });

  // All requests, phone (390 px): the Archived fold holds it, grey, timer-off, "Inactive" (under 430 px).
  await page.goto('/');
  const fold = page.getByTestId('closed-fold');
  await expect(fold).toBeVisible({ timeout: 20_000 });
  const row = page.locator(`[data-request-id="${r.id}"]`);
  if (!(await row.isVisible())) await fold.click();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-closed', '');
  await expect(row.locator('[data-glyph="inactive"]')).toBeVisible();
  await expect(row.locator('[data-glyph="closed"]')).toHaveCount(0);
  await expect(row.locator('[data-narrow]')).toHaveText(NARROW);
  await expect(row.locator('[data-narrow]')).toBeVisible();
  // The row's sentence says it in full.
  await expect(row).toHaveAccessibleName(new RegExp(`${r.caseNumber}.*Closed, inactive`));
  // From 430 px the full label, one line.
  await page.setViewportSize({ width: 430, height: 900 });
  const wide = row.getByText(LABEL, { exact: true });
  await expect(wide).toBeVisible();
  expect(await oneLine(wide)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });

  // Its detail: "Closed · inactive", grey, by System; the trail has the change and its note; Reopen in the bar.
  await row.click();
  const block = page.getByTestId('status-block');
  await expect(block.getByTestId('status-label')).toHaveText(LABEL);
  await expect(block).toHaveAttribute('data-stage', 'inactive');
  await expect(block).toHaveAttribute('data-tone', 'gray');
  await expect(block.locator('[data-glyph="inactive"]')).toBeVisible();
  await expect(block).toContainText('System');
  await expect(page.getByText('No activity for 1 h')).toBeVisible();
  const reopen = page.getByTestId('reopen');
  await expect(reopen).toHaveText('Reopen');
  await expect(page.getByTestId('profile-actions').getByRole('button')).toHaveCount(1);

  // Reopen: In medical again, then on Pending's Friend coming.
  await reopen.click();
  await expect(block.getByTestId('status-label')).toHaveText(STATUS_META[STATUS.inMedical].label);
  await expect(page.getByText('Reopened')).toBeVisible();
  await expect.poll(async () => (await call<RequestDetail>(page.request, 'GET', `/api/requests/${r.id}`)).status).toBe(STATUS.inMedical);
  await page.goto('/?view=pending');
  await expect(page.locator(`[data-testid="friend-coming-card"][data-pending-card="${r.id}"]`)).toBeVisible({ timeout: 20_000 });
});

test('regression: a backlog close raises no alert on the logger\'s open phone; a fresh close does', async ({ page }) => {
  test.setTimeout(90_000);
  const fresh = await answeredRequest(page);
  const backlog = await answeredRequest(page);
  // The logger's phone is open on All requests with both In medical (the store's baseline: no alert for them).
  await page.goto('/');
  for (const r of [fresh, backlog]) await expect(page.locator(`[data-request-id="${r.id}"]`).first()).toBeVisible({ timeout: 20_000 });
  // One idle just past the hour, one long past it (the first run after the migration, or after a paused job).
  backdate(fresh.id, INACTIVE_MINUTES + 1);
  backdate(backlog.id, 3 * INACTIVE_MINUTES);
  expect(psql(`select public.lp_close_inactive(array[${lit(fresh.id)}, ${lit(backlog.id)}]::uuid[])`)).toBe('2');
  const toast = (r: RequestSummary) => page.locator('.lp-toast').filter({ hasText: new RegExp(`${formatCaseNumber(r.caseNumber)} · .+ — closed · inactive`) });
  // The next poll brings both (one statement closed them, so one sync): the fresh close is a status change like any
  // other; the backlog is closed quietly.
  await expect(toast(fresh)).toBeVisible({ timeout: 20_000 });
  await expect(toast(backlog)).toHaveCount(0);
  await expect(page.locator('.lp-toast').filter({ hasText: /\d+ updates/ })).toHaveCount(0);
});

test('overflow 375–1440 px: the row, the request and the dashboard tile, each on one line', async ({ page }) => {
  test.setTimeout(150_000);
  const r = await inactiveRequest(page);
  const filter = `/?status=${encodeURIComponent(STATUS.inactive)}`;
  for (const width of OVERFLOW_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });

    // The list, filtered to Closed · inactive (phone log under 768 px, the desk table from 768).
    await page.goto(filter);
    const row = page.locator(`[data-request-id="${r.id}"]`).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expectNoOverflow(page, row, `row ${width}`);
    const label = row.getByText(width < 430 ? NARROW : LABEL, { exact: true });
    await expect(label).toBeVisible();
    expect(await oneLine(label), `status at ${width}`).toBe(true);

    // The request (docked beside the list from 1024 px).
    await row.click();
    const block = page.getByTestId('status-block');
    await expect(block.getByTestId('status-label')).toHaveText(LABEL);
    expect(await oneLine(block.getByTestId('status-label')), `block at ${width}`).toBe(true);
    await expectNoOverflow(page, block, `status block ${width}`);
    await expect(page.getByTestId('reopen')).toBeVisible();
    await expectNoOverflow(page, page.getByTestId('profile-actions'), `action bar ${width}`);

    // The dashboard: Closed · inactive, one line, its count.
    await page.goto('/?dashboard=1');
    const tile = page.getByTestId('tile-inactive');
    await expect(tile).toBeVisible({ timeout: 20_000 });
    await expect(tile).toContainText(LABEL);
    await expect.poll(async () => Number(await page.getByTestId('tile-inactive-value').textContent())).toBeGreaterThanOrEqual(1);
    expect(await oneLine(tile.getByText(LABEL, { exact: true })), `tile at ${width}`).toBe(true);
    await expectNoOverflow(page, page.locator('section[aria-label="Totals"]'), `dashboard tiles ${width}`);

    // My requests (the logger's), a phone (from 768 px it is the desk table, checked above): its card under Closed,
    // the progress line ending "Closed · inactive", uncut.
    if (width >= 768) continue;
    await page.goto('/?view=mine');
    const card = page.locator(`[data-testid="mine-card"]:has([data-request-id="${r.id}"])`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator('[data-glyph="inactive"]').first()).toBeVisible();
    const lastStep = card.getByText(LABEL, { exact: true }).last();
    await expect(lastStep).toBeVisible();
    expect(await oneLine(lastStep), `progress line at ${width}`).toBe(true);
    await expectNoOverflow(page, card, `My requests card ${width}`);
  }
});
