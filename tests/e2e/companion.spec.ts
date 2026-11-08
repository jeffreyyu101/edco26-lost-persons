// (Companion, 2026-11-08) design/screens/companion-v1.html ?w=B. End to end on the real store, API and database:
//   * intake: "Is a friend already with them in medical?" Yes + a name → the request page's quiet Friend row;
//   * answer Located → "Someone already with them?" Yes → amber "Located · already accompanied" + Request swap |
//     Friend informed;
//   * Request swap → the answerer's sheet → Swap at Main Med → green "Swap at Main Med" → Swap done → Reunited;
//   * Friend informed closes; Decline returns to Accompanied;
//   * offline: Friend informed says "Needs a connection" and nothing pretends to be saved (status taps are not
//     queued, as every answer).
// Synthetic rows only (TEST-COMP-…), closed again afterwards.
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { RequestDetail, RequestSummary } from '../../lib/api-types';
import { STATUS } from '../../lib/domain';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { signedInAs, type TestStaff } from './helpers/session';
import { syncRows } from './helpers/sync';

const BASE = testBaseUrl();
const STAFF: TestStaff = { staffName: 'TEST-COMP Transpo', team: 'GC/HX - Special Operations/Med Transpo' };
const TAG = `TEST-COMP-${Date.now().toString(36)}`;
let seq = 0;

test.use({ serviceWorkers: 'block' });
signedInAs(STAFF);

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function call<T>(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function createRequest(request: APIRequestContext, extra: Record<string, unknown> = {}): Promise<RequestSummary> {
  seq += 1;
  const body = { clientMutationId: randomUUID(), reportingLocation: 'FA 4 – Oasis', name: `${TAG} P${seq}`, age: '21', gender: 'Female', ...extra };
  const { request: row } = await call<{ request: RequestSummary }>(request, 'POST', '/api/requests', body);
  created.push({ id: row.id, request });
  return row;
}

const setStatus = async (request: APIRequestContext, r: RequestSummary, status: string, kind = 'answer') =>
  (await call<{ request: RequestSummary }>(request, 'POST', `/api/requests/${r.id}/status`, { status, expectedVersion: r.rowVersion, kind })).request;

const detail = (request: APIRequestContext, id: string) => call<RequestDetail>(request, 'GET', `/api/requests/${id}`);

async function accompanied(request: APIRequestContext): Promise<RequestSummary> {
  const r = await createRequest(request);
  return setStatus(request, r, STATUS.accompanied);
}

test.afterEach(async () => {
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await detail(request, id);
      if (row.status === STATUS.waiting) {
        await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: BASE } });
      } else if (row.status === STATUS.inMedical) {
        await request.fetch(`/api/requests/${id}/status`, { method: 'POST', data: { status: STATUS.reunited, expectedVersion: row.rowVersion, kind: 'reunite' }, headers: { Origin: BASE } });
      } else if (row.status === STATUS.accompanied) {
        await request.fetch(`/api/requests/${id}/status`, { method: 'POST', data: { status: STATUS.friendInformed, expectedVersion: row.rowVersion, kind: 'inform' }, headers: { Origin: BASE } });
      }
    } catch {
      // Best effort.
    }
  }
});

const statusLabel = (page: Page) => page.getByTestId('status-block').getByTestId('status-label');

test('intake: Yes + a name shows "Friend · may be with them · <name>" while Waiting', async ({ page }) => {
  await page.goto('/?new=1');
  await expect(page.getByTestId('request-form-submit')).toBeVisible();
  await page.getByRole('button', { name: /^Reporting from/ }).click();
  const posts = page.getByRole('dialog', { name: 'Reporting from' });
  await posts.locator('label', { hasText: 'FA 4' }).click();
  await posts.getByRole('button', { name: 'Done' }).click();
  const name = `${TAG} intake`;
  await page.getByRole('group', { name: 'Missing person' }).getByLabel('Name', { exact: true }).fill(name);
  const q = page.getByTestId('friend-in-medical');
  await expect(q.getByRole('radio', { name: 'Not sure' })).toHaveAttribute('aria-checked', 'true');
  await q.getByRole('radio', { name: 'Yes' }).click();
  await q.getByLabel('Name').fill('Alex');
  await page.getByTestId('request-form-submit').click();

  const named = async () => (await syncRows<RequestSummary>(page.request)).find((r) => r.name === name) ?? null;
  await expect.poll(async () => (await named())?.friendInMedical ?? null, { timeout: 20_000 }).toBe('yes');
  const row = await named();
  expect(row?.friendInMedicalName).toBe('Alex');
  if (row) created.push({ id: row.id, request: page.request });
  await page.goto(`/?r=${row?.id}`);
  await expect(page.getByTestId('friend-may-be')).toContainText('Alex');
});

test('answer Located → Yes: amber Located · already accompanied with Request swap | Friend informed', async ({ page }) => {
  const r = await createRequest(page.request, { friendInMedical: 'yes' });
  await page.goto(`/?r=${r.id}`);
  await page.getByTestId('profile-actions').getByRole('button', { name: 'Located', exact: true }).click();
  const sheet = page.getByTestId('located-sheet');
  await expect(sheet.getByText('Someone already with them?')).toBeVisible();
  await expect(sheet.getByTestId('located-yes')).toHaveAttribute('data-hint', '');
  await sheet.getByTestId('located-yes').click();
  await expect(statusLabel(page)).toHaveText('Located · already accompanied', { timeout: 20_000 });
  await expect(page.getByTestId('status-block')).toHaveAttribute('data-tone', 'amber');
  const footer = page.getByTestId('profile-actions');
  await expect(footer.getByTestId('request-swap')).toHaveText(/Request swap/);
  await expect(footer.getByTestId('friend-informed')).toHaveText(/Friend informed/);
  await expect(page.getByTestId('friend-may-be')).toHaveCount(0);
  expect((await detail(page.request, r.id)).status).toBe(STATUS.accompanied);
});

test('Request swap → the sheet → Swap at Main Med → Swap done → Reunited', async ({ page }) => {
  const r = await accompanied(page.request);
  await page.goto(`/?r=${r.id}`);
  await page.getByTestId('request-swap').click();
  await expect(statusLabel(page)).toHaveText('Friend swap requested', { timeout: 20_000 });
  // The requester opens the decision from the bar (it opens by itself for anyone else).
  await page.getByTestId('swap-decide').click();
  const sheet = page.getByTestId('swap-sheet');
  await expect(sheet.getByTestId('swap-fa')).toContainText('Swap at FA 4');
  await sheet.getByTestId('swap-mm').click();
  await expect(statusLabel(page)).toHaveText('Swap at Main Med', { timeout: 20_000 });
  await expect.poll(async () => (await detail(page.request, r.id)).swapPlace).toBe('mm');
  await page.getByTestId('swap-done').click();
  await expect(statusLabel(page)).toHaveText('Reunited', { timeout: 20_000 });
  expect((await detail(page.request, r.id)).status).toBe(STATUS.reunited);
});

test('Friend informed closes; Decline returns to Accompanied', async ({ page }) => {
  const a = await accompanied(page.request);
  await page.goto(`/?r=${a.id}`);
  await page.getByTestId('friend-informed').click();
  await expect(statusLabel(page)).toHaveText('Friend informed', { timeout: 20_000 });
  expect((await detail(page.request, a.id)).status).toBe(STATUS.friendInformed);

  const b = await accompanied(page.request);
  await page.goto(`/?r=${b.id}`);
  await page.getByTestId('request-swap').click();
  await expect(statusLabel(page)).toHaveText('Friend swap requested', { timeout: 20_000 });
  await page.getByTestId('swap-decide').click();
  await page.getByTestId('swap-sheet').getByTestId('swap-decline').click();
  await expect(statusLabel(page)).toHaveText('Located · already accompanied', { timeout: 20_000 });
  await expect.poll(async () => (await detail(page.request, b.id)).swapRequestedAt ?? null).toBeNull();
});

test('offline: Friend informed says "Needs a connection" and stays Accompanied', async ({ page, context }) => {
  const r = await accompanied(page.request);
  await page.goto(`/?r=${r.id}`);
  await expect(statusLabel(page)).toHaveText('Located · already accompanied', { timeout: 20_000 });
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByTestId('profile-actions')).toContainText('Needs a connection');
  await expect(page.getByTestId('friend-informed')).toBeDisabled();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('friend-informed')).toBeEnabled({ timeout: 20_000 });
  expect((await detail(page.request, r.id)).status).toBe(STATUS.accompanied);
  await page.getByTestId('friend-informed').click();
  await expect(statusLabel(page)).toHaveText('Friend informed', { timeout: 20_000 });
});
