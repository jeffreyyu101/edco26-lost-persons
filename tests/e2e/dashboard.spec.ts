import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ChangeResponse, CreateResponse, RequestDetail, RequestSummary } from '../../lib/api-types';
import { addSessionCookie } from './helpers/session';

// Dashboard and account menu (spec §8 Dashboard / Avatar menu, §9.4 "dashboard numbers, and a tile filtering
// All", "the CSV download"). The database is shared, so numbers are asserted as DELTAS from what the
// dashboard showed before this test's own changes (v2.1 A17), never as seed totals. Stats poll every 15 s.
// Runs at integration against the real store and API. Synthetic rows only (TEST-P-D…), closed afterwards.

const FRONT = { staffName: 'TEST-P Dashboard', team: 'GC/HX - Base' };
const POLL = { timeout: 40_000, intervals: [1_000, 2_000, 5_000] };

const unique = () => `TEST-P-D${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const created: Array<{ id: string; request: APIRequestContext }> = [];

async function api<T>(request: APIRequestContext, origin: string, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: origin } });
  expect(res.ok(), `${method} ${path} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function createRequest(page: Page, origin: string, reportingLocation: string): Promise<RequestSummary> {
  const { request } = await api<CreateResponse>(page.request, origin, 'POST', '/api/requests', {
    clientMutationId: randomUUID(),
    reportingLocation,
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
    waiting: await count(page.getByTestId('legend-waiting')),
    inMedical: await count(page.getByTestId('legend-in-medical')),
    fa4: await count(page.getByRole('button', { name: /^FA 4 – Oasis: \d+ open$/ })),
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

test('open counts move by the deltas of this test, and tiles, legend and bars open All filtered', async ({ context, page, baseURL }) => {
  const origin = baseURL as string;
  await addSessionCookie(context, FRONT);
  await page.goto('/?dashboard=1');
  await expect(page.getByTestId('open-count')).toBeVisible();
  await expect(page.getByTestId('dashboard-live')).toHaveText('Live');
  const before = await numbers(page);
  expect(before.open).toBe(before.waiting + before.inMedical);

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

  // Recently updated lists it (most recent first) and opens its profile.
  const recent = page.getByRole('region', { name: 'Recently updated' });
  await expect(recent.getByRole('button', { name: new RegExp(row.name) })).toBeVisible();
  await recent.getByRole('button', { name: new RegExp(row.name) }).click();
  await expect(page).toHaveURL(new RegExp(`\\?r=${row.id}$`));
  await expect(page.getByTestId('profile')).toBeVisible();
  await page.goBack();

  // Tiles, legend rows and bars open All filtered.
  await page.getByTestId('tile-not-in-medical').click();
  await expect(page).toHaveURL(/\?status=Checked\+%E2%80%93\+Not\+Found$/);
  await expect(page.getByTestId('request-list')).toBeVisible();
  await page.goBack();
  await page.getByTestId('legend-in-medical').click();
  await expect(page).toHaveURL(/\?status=Found\+%E2%80%93\+Awaiting\+Reunion$/);
  await expect(page.locator(`[data-request-id="${row.id}"]`)).toBeVisible();
  await page.goBack();
  await page.getByRole('button', { name: /^FA 4 – Oasis: \d+ open$/ }).click();
  await expect(page).toHaveURL(/\?post=FA\+4$/);
  await expect(page.locator(`[data-request-id="${row.id}"]`)).toBeVisible();
  await page.goBack();

  // Back to the list.
  await page.getByRole('button', { name: 'Back to requests' }).click();
  await expect(page.getByTestId('dashboard')).toHaveCount(0);
});

test('Export CSV downloads the log with this test’s row in it', async ({ context, page, baseURL }) => {
  const origin = baseURL as string;
  await addSessionCookie(context, FRONT);
  const row = await createRequest(page, origin, 'Command');
  await page.goto('/?dashboard=1');
  await expect(page.getByTestId('open-count')).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^lost-persons-\d{4}-\d{2}-\d{2}\.csv$/);
  const path = await download.path();
  const { readFile } = await import('node:fs/promises');
  const csv = await readFile(path, 'utf8');
  expect(csv).toContain(row.name);
});

test('the account menu shows who is signed in, switches theme, and opens the dashboard', async ({ context, page }) => {
  await addSessionCookie(context, FRONT);
  await page.goto('/');
  await page.getByTestId('account-trigger').click();
  const menu = page.getByRole('dialog', { name: 'Account' });
  await expect(menu).toContainText(FRONT.staffName);
  await expect(menu).toContainText('GCHX Base');
  await expect(menu).toContainText('Built by Jeffrey Yu');
  await expect(menu.getByRole('link', { name: 'Export CSV' })).toHaveAttribute('href', '/api/export');

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
