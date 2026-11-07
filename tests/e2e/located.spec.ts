// (2026-11-07, Located / Not located; design/DECISIONS.md, BUILD_SPEC A104) HIPAA: no status or answer wording on
// screen says a named person is "in medical". End to end on the real store, API and database, Chromium and WebKit:
//   * Pending (phone): "⧗ Pending" and "✓ Located"; the hold's chip and Undo bar; the final "× Not located"
//     and its Undo bar; Located's sheet "<name> located"; Friend coming's card; nothing on a card says "medical";
//   * the request page: the status block, the audit trail and Change answer's menu, Located and Not located;
//   * the desk table's status cells (Located · Bed 3, Pending · 9m, Not located · 2 checks), whole.
// Synthetic rows only (TEST-LOC-…), closed again afterwards.
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { RequestDetail, RequestSummary } from '../../lib/api-types';
import { STATUS } from '../../lib/domain';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { signedInAs, type TestStaff } from './helpers/session';

const BASE = testBaseUrl();
const MEDIC: TestStaff = { staffName: 'TEST-LOC Medic', team: 'Medical' };
const TAG = `TEST-LOC-${Date.now().toString(36)}`;
/** Status wording that names medical (the Medical team's name and the app title are not status wording). */
const SAYS_MEDICAL = /in medical|not found|not in medical/i;
let seq = 0;

test.use({ serviceWorkers: 'block' });
signedInAs(MEDIC);

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function call<T>(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function createRequest(request: APIRequestContext): Promise<RequestSummary> {
  seq += 1;
  const body = { clientMutationId: randomUUID(), reportingLocation: 'FA 4 – Oasis', name: `${TAG} P${seq}`, age: '21', gender: 'Female', clothing: `Synthetic ${TAG} ${seq}` };
  const { request: row } = await call<{ request: RequestSummary }>(request, 'POST', '/api/requests', body);
  created.push({ id: row.id, request });
  return row;
}

const setStatus = async (request: APIRequestContext, r: RequestSummary, status: string, kind = 'answer') =>
  (await call<{ request: RequestSummary }>(request, 'POST', `/api/requests/${r.id}/status`, { status, expectedVersion: r.rowVersion, kind })).request;

const detail = (request: APIRequestContext, id: string) => call<RequestDetail>(request, 'GET', `/api/requests/${id}`);

test.afterEach(async () => {
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await detail(request, id);
      if (row.status === STATUS.waiting) {
        await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: BASE } });
      } else if (row.status === STATUS.inMedical) {
        await request.fetch(`/api/requests/${id}/status`, { method: 'POST', data: { status: STATUS.reunited, expectedVersion: row.rowVersion, kind: 'reunite' }, headers: { Origin: BASE } });
      }
    } catch {
      // Best effort.
    }
  }
});

const checkCard = (page: Page, id: string) => page.locator(`[data-testid="check-card"]:has([data-request-id="${id}"])`);
const comingCard = (page: Page, id: string) => page.locator(`[data-testid="friend-coming-card"]:has([data-request-id="${id}"])`);

/** A card's words as they show and as a screen reader hears them (its own label and every button's). */
async function cardWords(card: Locator): Promise<string> {
  return card.evaluate((el) => {
    const said = [...el.querySelectorAll('[aria-label]')].map((x) => x.getAttribute('aria-label') ?? '');
    return [(el as HTMLElement).innerText, ...said].join(' | ');
  });
}

test('Pending: ⧗ Pending, then × Not located; ✓ Located opens "<name> located"; no card says medical', async ({ page }) => {
  const held = await createRequest(page.request);
  const located = await createRequest(page.request);
  await page.goto('/?view=pending');
  const card = checkCard(page, held.id);
  await expect(card).toBeVisible({ timeout: 20_000 });

  // The two answers.
  const answer = card.getByTestId('not-found-answer');
  await expect(answer).toHaveText('Pending');
  await expect(answer).toHaveAccessibleName('Pending. Keeps this request open and schedules a recheck');
  await expect(card.getByRole('button', { name: 'Located', exact: true })).toBeVisible();
  expect(await cardWords(card)).not.toMatch(SAYS_MEDICAL);

  // The first: the hold's chip and Undo bar.
  await answer.click();
  await expect(card.getByTestId('hold-chip')).toHaveText('Pending');
  await expect(page.getByRole('status').filter({ hasText: /^Pending · recheck in 20 min/ })).toBeVisible();
  await expect(answer).toHaveText('Not located');
  await expect(answer).toHaveAccessibleName('Not located. Closes this request as not located');
  expect(await cardWords(card)).not.toMatch(SAYS_MEDICAL);

  // The final one closes it: "<initials> closed · not located".
  await answer.click();
  await expect(page.getByRole('status').filter({ hasText: /closed · not located/ })).toBeVisible();
  await expect.poll(async () => (await detail(page.request, held.id)).status).toBe(STATUS.notInMedical);

  // ✓ Located: saved at once, then the location sheet names the request "… located".
  await checkCard(page, located.id).getByRole('button', { name: 'Located', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: `${located.name} located` });
  await expect(sheet).toBeVisible();
  await expect(sheet).not.toContainText(SAYS_MEDICAL);
  await sheet.getByRole('textbox', { name: 'Location' }).fill('Chair 9');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);
  const coming = comingCard(page, located.id);
  await expect(coming).toBeVisible();
  await expect(coming.locator(`[data-request-id="${located.id}"]`).first()).toHaveAccessibleName(/^.+\. Located, Chair 9, /);
  expect(await cardWords(coming)).not.toMatch(SAYS_MEDICAL);
  // No card on Pending says medical.
  for (const c of await page.locator('[data-testid="check-card"], [data-testid="friend-coming-card"]').all()) {
    expect(await cardWords(c)).not.toMatch(SAYS_MEDICAL);
  }
});

test('the request page: Located · friend coming and Not located, the audit trail and Change answer', async ({ page }) => {
  const r = await setStatus(page.request, await createRequest(page.request), STATUS.inMedical);
  await page.goto(`/?r=${r.id}`);
  const block = page.getByTestId('status-block');
  await expect(block.getByTestId('status-label')).toHaveText('Located · friend coming', { timeout: 20_000 });
  await expect(page.getByTestId('audit-item').first()).toContainText('Located');

  const changeAnswer = page.getByTestId('profile-actions').getByRole('button', { name: 'Change answer' });
  await changeAnswer.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Not located', 'Back to Waiting for check']);
  await menu.getByRole('menuitem', { name: 'Not located', exact: true }).click();
  await expect(block.getByTestId('status-label')).toHaveText('Not located');
  await expect(page.getByRole('status').filter({ hasText: /not located/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('audit-item').first()).toContainText('Located');
  await expect(page.getByTestId('audit-item').first()).toContainText('Not located');

  await changeAnswer.click();
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['Located', 'Back to Waiting for check']);
  await page.keyboard.press('Escape');

  const words = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="profile"]') as HTMLElement;
    const said = [...root.querySelectorAll('[aria-label]')].map((x) => x.getAttribute('aria-label') ?? '');
    return [root.innerText, ...said].join(' | ');
  });
  expect(words).not.toMatch(SAYS_MEDICAL);
});

test.describe('desk', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test('the table: Located · Bed 3, Pending · 9m, Not located · 2 checks, whole; no status cell says medical', async ({ page }) => {
    const held = await setStatus(page.request, await createRequest(page.request), STATUS.notInMedical);
    let located = await setStatus(page.request, await createRequest(page.request), STATUS.inMedical);
    located = (await call<{ request: RequestSummary }>(page.request, 'PATCH', `/api/requests/${located.id}`, { patch: { medicalLocation: 'Bed 3' }, expectedVersion: located.rowVersion })).request;
    const final = await setStatus(page.request, await setStatus(page.request, await createRequest(page.request), STATUS.notInMedical), STATUS.notInMedical);

    await page.goto('/');
    const cell = (id: string) => page.locator(`[data-desk-table] [data-request-id="${id}"] [data-col="status"]`);
    const shown = (id: string) =>
      cell(id).evaluate((el) =>
        [...el.querySelectorAll('span')]
          .filter((x) => x.getBoundingClientRect().width > 0)
          .map((x) => x.textContent?.trim())
          .join(' '),
      );
    await expect(cell(held.id)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => shown(held.id)).toMatch(/^Pending · (now|\d+m)$/);
    await expect.poll(() => shown(located.id)).toBe('Located · Bed 3');
    await page.getByTestId('closed-fold').first().click();
    await expect.poll(() => shown(final.id)).toBe('Not located · 2 checks');
    for (const id of [held.id, located.id, final.id]) {
      expect(await cell(id).evaluate((el) => [...el.querySelectorAll('span')].every((s) => s.scrollWidth <= s.clientWidth + 1))).toBe(true);
    }
    const statusWords = await page.locator('[data-desk-table] [data-col="status"]').evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText).join(' | '));
    expect(statusWords).not.toMatch(SAYS_MEDICAL);
    // The open request docked beside the table says the same.
    await page.locator(`[data-desk-table] [data-request-id="${located.id}"]`).first().click();
    await expect(page.getByTestId('status-block').getByTestId('status-label')).toHaveText('Located · friend coming', { timeout: 15_000 });
  });
});
