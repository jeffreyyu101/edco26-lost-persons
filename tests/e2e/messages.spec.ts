import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { RequestDetail, RequestSummary, ThreadPage } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { OVERFLOW_WIDTHS, expectNoOverflow } from './helpers/overflow';
import { newSignedInContext, signedInAs } from './helpers/session';

// F3 Messages + en route (design/screens/updates.html v7, #clarify, #edit; f34-states.html 5–6), end to end
// with two phones on the real store, API and database:
//   medical asks from a To check card on a Waiting request → front of house sees the badge and the preview,
//   replies → medical sees the reply and "Read" → In medical → En route ~5 min → Change ETA → Cancel + Undo →
//   Arrived → Reunited clears it; medical sees the row read-only; an offline message is sent once later;
//   and no F3 screen overflows at 375, 390, 820, 1180 or 1440 px.
// Synthetic rows only (TEST-F3-…), closed again afterwards.

const BASE = testBaseUrl();
const FOH = { staffName: 'TEST-F3 Dana Front', team: 'GC/HX - Dispatch' };
const MED = { staffName: 'TEST-F3 Rae Medic', team: 'Medical' };
const TAG = `TEST-F3-${Date.now().toString(36)}`;
let seq = 0;

test.use({ serviceWorkers: 'block' });
signedInAs(FOH);

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function call<T>(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function createRequest(request: APIRequestContext): Promise<RequestSummary> {
  seq += 1;
  const { request: row } = await call<{ request: RequestSummary }>(request, 'POST', '/api/requests', {
    clientMutationId: randomUUID(),
    reportingLocation: 'FA 3 – Kinetic',
    name: `${TAG} P${seq}`,
    age: 'mid-20s',
    gender: 'Male',
    clothing: `Synthetic ${TAG} red hoodie ${seq}`,
    contactName: `${TAG} Friend ${seq}`,
  });
  created.push({ id: row.id, request });
  return row;
}

async function setStatus(request: APIRequestContext, id: string, status: string, kind: string): Promise<RequestSummary> {
  const row = await call<RequestDetail>(request, 'GET', `/api/requests/${id}`);
  return (await call<{ request: RequestSummary }>(request, 'POST', `/api/requests/${id}/status`, { status, expectedVersion: row.rowVersion, kind })).request;
}

test.afterEach(async () => {
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await call<RequestDetail>(request, 'GET', `/api/requests/${id}`);
      if (row.status === 'Added') await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: BASE } });
      else if (row.status === 'Found – Awaiting Reunion')
        await request.fetch(`/api/requests/${id}/status`, { method: 'POST', data: { status: 'Reunited – Closed', expectedVersion: row.rowVersion, kind: 'reunite' }, headers: { Origin: BASE } });
    } catch {
      // Best effort.
    }
  }
});

const checkCard = (page: Page, id: string) => page.locator(`[data-testid="check-card"]:has([data-request-id="${id}"])`);
const mineCard = (page: Page, id: string) => page.locator(`[data-testid="mine-card"]:has([data-request-id="${id}"])`);
const messages = (page: Page) => page.getByTestId('messages');
const SYNC = { timeout: 20_000 };

async function send(page: Page, text: string): Promise<void> {
  const input = messages(page).getByTestId('composer-input');
  await input.fill(text);
  await messages(page).getByTestId('composer-send').click();
  await expect(input).toHaveValue('');
}

async function openMine(page: Page, id: string): Promise<Locator> {
  await page.goto('/?view=mine');
  const card = mineCard(page, id);
  await expect(card).toBeVisible(SYNC);
  return card;
}

test('medical asks from To check; front of house replies; read; en route, change, cancel + undo, arrived; reunited clears it', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const medCtx: BrowserContext = await newSignedInContext(browser, MED, { viewport: { width: 390, height: 844 } });
  const med = await medCtx.newPage();
  try {
    const r = await createRequest(page.request);

    // Medical: Pending → To check card: the Message button left of the two answers.
    await med.goto('/?view=pending');
    const card = checkCard(med, r.id);
    await expect(card).toBeVisible(SYNC);
    const acts = card.getByTestId('message-button');
    await expect(acts).toHaveAttribute('aria-label', /^Message about/);
    const [msgBox, answerBox] = await Promise.all([acts.boundingBox(), card.getByRole('button', { name: 'In medical', exact: true }).boundingBox()]);
    expect(!!msgBox && !!answerBox && msgBox.x < answerBox.x).toBe(true);
    expect(Math.round(msgBox?.height ?? 0)).toBeGreaterThanOrEqual(44);
    await acts.click();
    await expect(med).toHaveURL(new RegExp(`r=${r.id}`));
    await expect(messages(med).getByTestId('thread-empty')).toHaveAttribute('aria-label', 'No messages yet');
    // The quick line sends at once.
    await messages(med).getByRole('button', { name: 'Send: Any tattoos or marks?' }).click();
    await expect(messages(med).getByTestId('bubble-mine')).toHaveText('Any tattoos or marks?');
    await expect(messages(med).getByTestId('receipt')).toHaveText('Delivered', SYNC);

    // Front of house: My requests shows the unread badge and the preview.
    const mine = await openMine(page, r.id);
    await expect(mine.getByTestId('unread-badge')).toHaveText('1', SYNC);
    await expect(mine.getByTestId('message-preview')).toContainText('Any tattoos or marks?');
    await expect(mine.getByTestId('preview-unread')).toBeVisible();
    await mine.getByTestId('message-button').click();
    await expect(messages(page).getByTestId('bubble-them')).toHaveText('Any tattoos or marks?', SYNC);
    // Front of house's quick lines while waiting.
    await expect(messages(page).getByTestId('quick-lines')).toContainText('Friend is still here');
    await send(page, 'Butterfly tattoo, left wrist');
    await expect(messages(page).getByTestId('bubble-mine')).toHaveText('Butterfly tattoo, left wrist');

    // Medical sees the reply and "Read" under the question.
    await expect(messages(med).getByTestId('bubble-them')).toHaveText('Butterfly tattoo, left wrist', SYNC);
    await expect(messages(med).getByTestId('receipt')).toHaveText(/^Read \d{1,2}:\d\d (AM|PM)$/, SYNC);
    // Screen readers heard it.
    await expect(med.getByTestId('thread-live')).toHaveText(/Butterfly tattoo, left wrist/);

    // In medical: front of house goes en route with ~5 min.
    await setStatus(med.request, r.id, 'Found – Awaiting Reunion', 'answer');
    const card2 = await openMine(page, r.id);
    await expect(card2.getByTestId('enroute-button')).toBeVisible(SYNC);
    await card2.getByTestId('enroute-button').click();
    const sheet = page.getByTestId('enroute-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('radio', { checked: true })).toHaveCount(0);
    await sheet.getByRole('radio', { name: /^~5 min/ }).click();
    await sheet.getByTestId('enroute-send').click();
    const row = card2.getByTestId('enroute-row');
    await expect(row).toContainText('Friend en route');
    await expect(row).toContainText(/~[45] min/);
    await expect(card2.getByTestId('arrived-button')).toBeVisible();

    // Medical sees it read-only (no names), on the request.
    await expect(med.getByTestId('status-block').getByTestId('enroute-row')).toContainText('Friend en route', SYNC);
    await expect(med.getByTestId('status-block').getByTestId('enroute-row')).toHaveAttribute('role', 'status');
    await expect(med.getByTestId('status-block').getByTestId('enroute-row')).not.toContainText('TEST-F3');

    // Change: the same sheet with my ETA selected; Update waits for a change.
    await row.click();
    await expect(sheet).toHaveAttribute('data-mode', 'edit');
    await expect(sheet.getByRole('radio', { name: /^~5 min/ })).toHaveAttribute('aria-checked', 'true');
    await expect(sheet.getByTestId('enroute-update')).toBeDisabled();
    await sheet.getByRole('radio', { name: /^~10 min/ }).click();
    await sheet.getByTestId('enroute-update').click();
    await expect(row).toContainText(/~(9|10) min/, SYNC);

    // Cancel + Undo.
    await row.click();
    await sheet.getByTestId('enroute-cancel').click();
    await expect(card2.getByTestId('enroute-row')).toHaveCount(0);
    await expect(card2.getByTestId('enroute-button')).toBeVisible();
    const snack = page.locator('.lp-snack');
    await expect(snack).toContainText('En route cancelled');
    await snack.getByRole('button', { name: 'Undo' }).click();
    await expect(card2.getByTestId('enroute-row')).toContainText(/~(9|10) min/, SYNC);

    // Arrived.
    await card2.getByTestId('arrived-button').click();
    await expect(card2.getByTestId('enroute-row')).toContainText('Friend arrived', SYNC);
    await expect.poll(async () => (await call<ThreadPage>(page.request, 'GET', `/api/requests/${r.id}/messages`)).activity.enroute?.state, SYNC).toBe('arrived');

    // Reunited clears it.
    await setStatus(med.request, r.id, 'Reunited – Closed', 'reunite');
    await expect(card2.getByTestId('enroute-row')).toHaveCount(0, SYNC);
  } finally {
    await medCtx.close();
  }
});

test('a message written offline shows "Sending…" and is sent exactly once when the signal is back', async ({ page, context }) => {
  test.setTimeout(90_000);
  const r = await createRequest(page.request);
  await page.goto(`/?r=${r.id}`);
  await expect(messages(page).getByTestId('thread-empty')).toBeVisible(SYNC);
  await context.setOffline(true);
  await send(page, 'On our way now');
  const bubble = messages(page).getByTestId('bubble-mine');
  await expect(bubble).toHaveText('On our way now');
  await expect(bubble).toHaveAttribute('data-pending', '');
  await expect(messages(page).getByTestId('receipt-sending')).toHaveText('Sending…');
  await page.waitForTimeout(3_000);
  await context.setOffline(false);
  await expect(messages(page).getByTestId('receipt-sending')).toHaveCount(0, SYNC);
  await expect(messages(page).getByTestId('receipt')).toHaveText('Delivered', SYNC);
  const thread = await call<ThreadPage>(page.request, 'GET', `/api/requests/${r.id}/messages`);
  expect(thread.messages.filter((m) => m.body === 'On our way now')).toHaveLength(1);
});

test.describe('no overflow', () => {
  for (const width of OVERFLOW_WIDTHS) {
    test(`thread, cards and the en route sheet at ${width} px`, async ({ browser, page }) => {
      test.setTimeout(90_000);
      const phone = width < 768;
      const ctx = await newSignedInContext(browser, FOH, { viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
      const p = await ctx.newPage();
      try {
        const r = await createRequest(page.request);
        const medCtx = await newSignedInContext(browser, MED);
        try {
          for (const text of ['Any tattoos or marks?', 'Bring 1 person only — and a very long line that has to wrap inside its bubble without pushing anything sideways']) {
            await call(medCtx.request, 'POST', `/api/requests/${r.id}/messages`, { clientMutationId: randomUUID(), body: text });
          }
        } finally {
          await medCtx.close();
        }
        await call(page.request, 'POST', `/api/requests/${r.id}/messages`, { clientMutationId: randomUUID(), body: 'Got it, just me and the friend' });
        await setStatus(page.request, r.id, 'Found – Awaiting Reunion', 'answer');
        await call(page.request, 'POST', `/api/requests/${r.id}/enroute`, { action: 'set', etaMinutes: 5 });

        await p.goto(`/?r=${r.id}`);
        await expect(messages(p).getByTestId('bubble-mine')).toBeVisible(SYNC);
        await expect(p.getByTestId('status-block').getByTestId('enroute-row')).toBeVisible(SYNC);
        await expectNoOverflow(p, '[data-testid="messages"]');
        await expectNoOverflow(p, '[data-testid="status-block"]');

        await p.goto('/?view=mine');
        const card = mineCard(p, r.id);
        if (await card.count()) {
          await expect(card.getByTestId('enroute-row')).toBeVisible(SYNC);
          await expectNoOverflow(p, `[data-testid="mine-card"]:has([data-request-id="${r.id}"])`);
          await card.getByTestId('enroute-row').click();
          await expect(p.getByTestId('enroute-sheet')).toBeVisible();
          await expectNoOverflow(p, '[data-testid="enroute-sheet"]');
          await p.keyboard.press('Escape');
        } else {
          // The desk shows My requests as a table row: the unread count after the name, no overflow.
          await expect(p.locator(`button[data-request-id="${r.id}"]`)).toBeVisible(SYNC);
          await expectNoOverflow(p, `button[data-request-id="${r.id}"]`);
        }
      } finally {
        await ctx.close();
      }
    });
  }
});
