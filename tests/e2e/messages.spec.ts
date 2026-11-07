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
const WALKER = { staffName: 'TEST-F3 Sam Walker', team: 'GC/HX - Base' };
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
const comingCard = (page: Page, id: string) => page.locator(`[data-testid="friend-coming-card"]:has([data-request-id="${id}"])`);

/** Pending → Friend coming (the tab on a phone or a narrow desk; the board's column otherwise). */
async function openComing(page: Page): Promise<void> {
  await page.goto('/?view=pending');
  const tab = page.getByRole('tab', { name: /^Friend coming/ });
  await expect.poll(async () => (await tab.isVisible()) || (await page.getByTestId('pending-column-coming').isVisible()), SYNC).toBe(true);
  if (await tab.isVisible()) await tab.click();
}
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

    // Medical sees it read-only (no names), on the request. Not a live region: its minute countdown is never
    // announced; a screen reader reads one sentence.
    const medRow = med.getByTestId('status-block').getByTestId('enroute-row');
    await expect(medRow).toContainText('Friend en route', SYNC);
    await expect(medRow).not.toHaveAttribute('role');
    await expect(medRow.locator('[role="status"], [aria-live]')).toHaveCount(0);
    await expect(medRow).toContainText(/Friend en route, about [45] min away\./);
    await expect(medRow).not.toContainText('TEST-F3');

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
    // The request's quick lines no longer offer En route (or Arrived) once the friend arrived, as on the card.
    await page.goto(`/?r=${r.id}`);
    await expect(page.getByTestId('status-block').getByTestId('enroute-row')).toContainText('Friend arrived', SYNC);
    await expect(messages(page).getByTestId('quick-lines').getByRole('button')).toHaveText(["Can't find them", 'Friend left the area']);

    // Reunited clears it.
    await openMine(page, r.id);
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

test('an En route tap that keeps failing shows "Not delivered · Retry" and keeps the row; Retry sends it', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const r = await createRequest(page.request);
  const medCtx = await newSignedInContext(browser, MED);
  try {
    await setStatus(medCtx.request, r.id, 'Found – Awaiting Reunion', 'answer');
  } finally {
    await medCtx.close();
  }
  await page.route('**/api/requests/*/enroute', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Down' } }) }),
  );
  const card = await openMine(page, r.id);
  await card.getByTestId('enroute-button').click();
  await page.getByTestId('enroute-sheet').getByRole('radio', { name: /^~5 min/ }).click();
  await page.getByTestId('enroute-send').click();
  await expect(card.getByTestId('enroute-row')).toContainText('Friend en route');
  // Three tries online (3 s, then 10 s apart): not delivered. What I asked for stays on the card.
  const failed = card.getByTestId('enroute-failed');
  await expect(failed).toContainText('Not delivered', { timeout: 40_000 });
  await expect(card.getByTestId('enroute-row')).toContainText('Friend en route');
  await expect(card.getByTestId('enroute-button')).toHaveCount(0);
  await expect(failed.getByTestId('enroute-retry')).toHaveAccessibleName('En route was not delivered. Retry.');
  const box = await failed.getByTestId('enroute-discard').boundingBox();
  expect(Math.round(box?.height ?? 0)).toBeGreaterThanOrEqual(32);
  await expectNoOverflow(page, `[data-testid="mine-card"]:has([data-request-id="${r.id}"])`);
  // Signal back: Retry sends it, the line goes, the server has it.
  await page.unroute('**/api/requests/*/enroute');
  await failed.getByTestId('enroute-retry').click();
  await expect(failed).toHaveCount(0, SYNC);
  await expect.poll(async () => (await call<RequestDetail>(page.request, 'GET', `/api/requests/${r.id}`)).enroute?.state, SYNC).toBe('enroute');
  await expect(card.getByTestId('enroute-row')).toContainText(/~[45] min/);
});

test.describe('no overflow', () => {
  for (const width of OVERFLOW_WIDTHS) {
    test(`thread, cards, the To check card and the en route sheet at ${width} px`, async ({ browser, page }) => {
      test.setTimeout(90_000);
      const phone = width < 768;
      const ctx = await newSignedInContext(browser, FOH, { viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
      const p = await ctx.newPage();
      try {
        const r = await createRequest(page.request);
        // A Waiting request medical asked about and front of house answered: Pending → To check's card.
        const waiting = await createRequest(page.request);
        const medCtx = await newSignedInContext(browser, MED);
        try {
          for (const text of ['Any tattoos or marks?', 'Bring 1 person only — and a very long line that has to wrap inside its bubble without pushing anything sideways']) {
            await call(medCtx.request, 'POST', `/api/requests/${r.id}/messages`, { clientMutationId: randomUUID(), body: text });
          }
          await call(medCtx.request, 'POST', `/api/requests/${waiting.id}/messages`, { clientMutationId: randomUUID(), body: 'Any tattoos or marks?' });
        } finally {
          await medCtx.close();
        }
        await call(page.request, 'POST', `/api/requests/${waiting.id}/messages`, {
          clientMutationId: randomUUID(),
          body: 'Butterfly tattoo on the left wrist, and a long answer that has to ellipsize on one line in the preview',
        });
        await call(page.request, 'POST', `/api/requests/${r.id}/messages`, { clientMutationId: randomUUID(), body: 'Got it, just me and the friend' });
        await setStatus(page.request, r.id, 'Found – Awaiting Reunion', 'answer');
        await call(page.request, 'POST', `/api/requests/${r.id}/enroute`, { action: 'set', etaMinutes: 5 });
        // Two more In medical requests of mine: someone else en route on one (read-only "late" row), and
        // the friend arrived on the other (green row).
        const others = await createRequest(page.request);
        const arrived = await createRequest(page.request);
        const walkerCtx = await newSignedInContext(browser, WALKER);
        try {
          for (const x of [others, arrived]) await setStatus(page.request, x.id, 'Found – Awaiting Reunion', 'answer');
          const late = new Date(Date.now() - 5 * 60_000).toISOString();
          await call(walkerCtx.request, 'POST', `/api/requests/${others.id}/enroute`, { action: 'set', etaAt: late, etaMinutes: 5 });
          await call(walkerCtx.request, 'POST', `/api/requests/${arrived.id}/enroute`, { action: 'set', etaMinutes: 10 });
          await call(walkerCtx.request, 'POST', `/api/requests/${arrived.id}/enroute`, { action: 'arrive' });
        } finally {
          await walkerCtx.close();
        }

        await p.goto(`/?r=${r.id}`);
        await expect(messages(p).getByTestId('bubble-mine')).toBeVisible(SYNC);
        await expect(p.getByTestId('status-block').getByTestId('enroute-row')).toBeVisible(SYNC);
        await expectNoOverflow(p, '[data-testid="messages"]');
        await expectNoOverflow(p, '[data-testid="status-block"]');

        // The en route sheet at every width: edit (mine, from the status block's row), then new (another
        // In medical request, from the composer's En route pill).
        await p.getByTestId('status-block').getByTestId('enroute-row').click();
        await expect(p.getByTestId('enroute-sheet')).toHaveAttribute('data-mode', 'edit');
        await expectNoOverflow(p, '[data-testid="enroute-sheet"]');
        await p.keyboard.press('Escape');
        await expect(p.getByTestId('enroute-sheet')).toHaveCount(0);
        await p.goto(`/?r=${others.id}`);
        await messages(p).getByRole('button', { name: /^En route/ }).click();
        await expect(p.getByTestId('enroute-sheet')).toHaveAttribute('data-mode', 'new');
        await expectNoOverflow(p, '[data-testid="enroute-sheet"]');
        await p.keyboard.press('Escape');

        await p.goto('/?view=mine');
        const card = mineCard(p, r.id);
        if (await card.count()) {
          await expect(card.getByTestId('enroute-row')).toBeVisible(SYNC);
          await expectNoOverflow(p, `[data-testid="mine-card"]:has([data-request-id="${r.id}"])`);
          // Someone else en route (read-only), and Friend arrived, on my own cards.
          for (const id of [others.id, arrived.id]) {
            const c = mineCard(p, id);
            await expect(c.getByTestId('enroute-row')).toBeVisible(SYNC);
            await c.scrollIntoViewIfNeeded();
            await expectNoOverflow(p, `[data-testid="mine-card"]:has([data-request-id="${id}"])`);
          }
          await expect(mineCard(p, arrived.id).getByTestId('enroute-row')).toContainText('Friend arrived');
          await card.getByTestId('enroute-row').click();
          await expect(p.getByTestId('enroute-sheet')).toBeVisible();
          await expectNoOverflow(p, '[data-testid="enroute-sheet"]');
          await p.keyboard.press('Escape');
        } else {
          // The desk shows My requests as a table row: the unread count after the name, no overflow.
          await expect(p.locator(`button[data-request-id="${r.id}"]`)).toBeVisible(SYNC);
          await expectNoOverflow(p, `button[data-request-id="${r.id}"]`);
        }

        // Medical: Pending → To check, the card with Message, the reply's preview and the two answers.
        const mctx = await newSignedInContext(browser, MED, { viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
        try {
          const mp = await mctx.newPage();
          await mp.goto('/?view=pending');
          const check = checkCard(mp, waiting.id);
          await expect(check.getByTestId('message-preview')).toContainText('Butterfly tattoo', SYNC);
          await check.scrollIntoViewIfNeeded();
          await expectNoOverflow(mp, `[data-testid="check-card"][data-pending-card="${waiting.id}"]`);
          // Pending → Friend coming: read-only en route rows (teal, amber "late") and Friend arrived (green).
          await openComing(mp);
          for (const [id, text] of [[r.id, /Friend en route/], [others.id, /late/], [arrived.id, /Friend arrived/]] as const) {
            const coming = comingCard(mp, id);
            await expect(coming.getByTestId('enroute-row')).toContainText(text, SYNC);
            await coming.scrollIntoViewIfNeeded();
            await expectNoOverflow(mp, `[data-testid="friend-coming-card"][data-pending-card="${id}"]`);
          }
        } finally {
          await mctx.close();
        }
      } finally {
        await ctx.close();
      }
    });
  }
});
