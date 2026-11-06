import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { RequestDetail, RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { signedInAs } from './helpers/session';

// Pending v8 (design/screens/pending-v8.html, Brian + Dani 2026-11-06 afternoon), end to end on the real
// store, API and database:
//   phone  To check | Friend coming, one list at a time, To check by default, the last tab remembered; the
//          v8 cards; In medical saves at once and then asks where they are (bottom sheet: Save, Skip, Esc or a
//          swipe down); the Friend coming chip edits the location; the request's status block shows it.
//   desk   both queues side by side (stacking into the tabs when the main column is narrow); the location
//          popover at the card; J / K walk To check, then Friend coming.
// Synthetic rows only (TEST-P8-…), closed again afterwards.

const BASE = testBaseUrl();
const STAFF = { staffName: 'TEST-P8 Medic', team: 'Medical' };
const TAG = `TEST-P8-${Date.now().toString(36)}`;
let seq = 0;

test.use({ serviceWorkers: 'block' });
signedInAs(STAFF);

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function call<T>(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function createRequest(page: Page, extra: Record<string, unknown> = {}): Promise<RequestSummary> {
  seq += 1;
  const { request } = await call<{ request: RequestSummary }>(page.request, 'POST', '/api/requests', {
    clientMutationId: randomUUID(),
    reportingLocation: 'FA 3 – Kinetic',
    name: `${TAG} P${seq}`,
    age: '21',
    gender: 'Female',
    clothing: `Synthetic ${TAG} jacket ${seq}`,
    contactName: `${TAG} Friend ${seq}`,
    contactRelationship: 'boyfriend',
    ...extra,
  });
  created.push({ id: request.id, request: page.request });
  return request;
}

async function inMedical(page: Page, r: RequestSummary, location?: string): Promise<RequestSummary> {
  let row = (await call<{ request: RequestSummary }>(page.request, 'POST', `/api/requests/${r.id}/status`, { status: 'Found – Awaiting Reunion', expectedVersion: r.rowVersion, kind: 'answer' })).request;
  if (location) row = (await call<{ request: RequestSummary }>(page.request, 'PATCH', `/api/requests/${r.id}`, { patch: { medicalLocation: location }, expectedVersion: row.rowVersion })).request;
  return row;
}

const detail = (page: Page, id: string) => call<RequestDetail>(page.request, 'GET', `/api/requests/${id}`);

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
const comingCard = (page: Page, id: string) => page.locator(`[data-testid="friend-coming-card"]:has([data-request-id="${id}"])`);
const tab = (page: Page, name: 'To check' | 'Friend coming') => page.getByRole('tab', { name: new RegExp(`^${name}`) });
const nameOf = (r: RequestSummary) => r.name;

/** A swipe down on `el` (touch events React reads, the same in Chromium and WebKit). */
async function swipeDown(el: Locator, distance: number) {
  await el.evaluate((node, dy) => {
    const box = node.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const fire = (type: string, clientY: number, touches: number) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      const list = touches ? [{ clientX: x, clientY, identifier: 1 }] : [];
      Object.defineProperty(ev, 'touches', { value: list });
      Object.defineProperty(ev, 'changedTouches', { value: [{ clientX: x, clientY, identifier: 1 }] });
      node.dispatchEvent(ev);
    };
    fire('touchstart', y, 1);
    for (let i = 1; i <= 4; i += 1) fire('touchmove', y + (dy * i) / 4, 1);
    fire('touchend', y + dy, 0);
  }, distance);
}

test.describe('phone', () => {
  test('To check by default, one list at a time; Friend coming shows where and who; the tab is remembered', async ({ page }) => {
    const waiting = await createRequest(page);
    const located = await inMedical(page, await createRequest(page), 'Chair 3');
    const unlocated = await inMedical(page, await createRequest(page, { contactRelationship: null }));
    await page.goto('/?view=pending');
    await expect(checkCard(page, waiting.id)).toBeVisible({ timeout: 15_000 });

    // No brand card; the large title, then the control.
    await expect(page.getByTestId('brand-card')).toHaveCount(0);
    await expect(tab(page, 'To check')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Friend coming')).toHaveAttribute('aria-selected', 'false');
    const title = (await page.getByTestId('view-switcher').boundingBox())!;
    const tabs = (await page.getByTestId('pending-tabs').boundingBox())!;
    expect(tabs.y).toBeGreaterThan(title.y + title.height - 1);
    await expect(comingCard(page, located.id)).toHaveCount(0);

    // The To check card: no photo placeholder, "FA 3 · LP-…", both answers at 44 px.
    const card = checkCard(page, waiting.id);
    await expect(card.getByTestId('card-photo')).toHaveCount(0);
    await expect(card).toContainText(`FA 3 · LP-${String(waiting.caseNumber).padStart(4, '0')}`);
    for (const name of ['Not in medical', 'In medical']) {
      expect((await card.getByRole('button', { name, exact: true }).boundingBox())!.height).toBeCloseTo(44, 0);
    }

    await tab(page, 'Friend coming').click();
    await expect(checkCard(page, waiting.id)).toHaveCount(0);
    await expect(comingCard(page, located.id).getByTestId('location-chip')).toHaveAccessibleName('Chair 3, edit location');
    await expect(comingCard(page, located.id)).toContainText(`${TAG} Friend ${seq - 1} · boyfriend, on the way`);
    await expect(comingCard(page, unlocated.id).getByTestId('location-chip')).toHaveAccessibleName('Add location');
    await expect(comingCard(page, unlocated.id)).toContainText(`${TAG} Friend ${seq} · on the way`);
    await expect(comingCard(page, unlocated.id).getByRole('button', { name: 'Reunited' })).toBeVisible();

    // Remembered on this device.
    await page.reload();
    await expect(tab(page, 'Friend coming')).toHaveAttribute('aria-selected', 'true');
    await expect(comingCard(page, located.id)).toBeVisible({ timeout: 15_000 });
    // Arrow keys move between the two tabs.
    await tab(page, 'Friend coming').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(tab(page, 'To check')).toBeFocused();
    await expect(tab(page, 'To check')).toHaveAttribute('aria-selected', 'true');
    await expect(checkCard(page, waiting.id)).toBeVisible();
  });

  test('In medical saves at once, then the sheet: Save shows the chip, and the In medical Undo still works', async ({ page }) => {
    const r = await createRequest(page);
    await page.goto('/?view=pending');
    await expect(checkCard(page, r.id)).toBeVisible({ timeout: 15_000 });
    await checkCard(page, r.id).getByRole('button', { name: 'In medical', exact: true }).click();

    const sheet = page.getByRole('dialog', { name: `${nameOf(r)} is in medical` });
    await expect(sheet).toBeVisible();
    const field = sheet.getByRole('textbox', { name: 'Location' });
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('type', 'text');
    await expect(field).toHaveAttribute('maxlength', '60');
    // Saved on the tap, before anything is typed.
    await expect.poll(async () => (await detail(page, r.id)).status).toBe('Found – Awaiting Reunion');

    await field.fill('Chair 12');
    await sheet.getByRole('button', { name: 'Save' }).click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(async () => (await detail(page, r.id)).medicalLocation).toBe('Chair 12');
    await tab(page, 'Friend coming').click();
    await expect(comingCard(page, r.id).getByTestId('location-chip')).toHaveAccessibleName('Chair 12, edit location');

    // The Undo from the answer is still there and still works; the location stays on the request.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(comingCard(page, r.id)).toHaveCount(0);
    await expect.poll(async () => (await detail(page, r.id)).status).toBe('Added');
    expect((await detail(page, r.id)).medicalLocation).toBe('Chair 12');
    const audit = (await detail(page, r.id)).audit.filter((e) => e.action === 'edit');
    expect(audit.map((e) => e.next)).toEqual([{ medicalLocation: 'Chair 12' }]);
  });

  test('Skip, Esc and a swipe down close the sheet with nothing more saved', async ({ page }) => {
    const rows = [await createRequest(page), await createRequest(page), await createRequest(page)];
    await page.goto('/?view=pending');
    await expect(checkCard(page, rows[2]!.id)).toBeVisible({ timeout: 15_000 });
    const answer = async (r: RequestSummary) => {
      await checkCard(page, r.id).getByRole('button', { name: 'In medical', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: `${nameOf(r)} is in medical` });
      await expect(sheet).toBeVisible();
      await sheet.getByRole('textbox', { name: 'Location' }).fill('Not saved');
      return sheet;
    };

    let sheet = await answer(rows[0]!);
    await sheet.getByRole('button', { name: 'Skip' }).click();
    await expect(sheet).toHaveCount(0);

    sheet = await answer(rows[1]!);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    sheet = await answer(rows[2]!);
    // A short drag springs back; a longer one closes it.
    await swipeDown(sheet.getByTestId('location-title'), 30);
    await expect(sheet).toBeVisible();
    await swipeDown(sheet.getByTestId('location-title'), 140);
    await expect(sheet).toHaveCount(0);

    for (const r of rows) {
      await expect.poll(async () => (await detail(page, r.id)).status).toBe('Found – Awaiting Reunion');
      expect((await detail(page, r.id)).medicalLocation).toBeNull();
    }
  });

  test('the Friend coming chip edits the location: change it, then clear it', async ({ page }) => {
    const r = await inMedical(page, await createRequest(page), 'Chair 3');
    await page.goto('/?view=pending');
    await tab(page, 'Friend coming').click();
    const chip = comingCard(page, r.id).getByTestId('location-chip');
    await expect(chip).toHaveAccessibleName('Chair 3, edit location', { timeout: 15_000 });

    await chip.click();
    const sheet = page.getByRole('dialog', { name: `${nameOf(r)} is in medical` });
    const field = sheet.getByRole('textbox', { name: 'Location' });
    await expect(field).toHaveValue('Chair 3');
    await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await field.fill('Bed 3 · triage');
    await page.keyboard.press('Enter');
    await expect(sheet).toHaveCount(0);
    await expect(chip).toHaveAccessibleName('Bed 3 · triage, edit location');

    await chip.click();
    await field.fill('');
    await sheet.getByRole('button', { name: 'Save' }).click();
    await expect(chip).toHaveAccessibleName('Add location');
    await expect.poll(async () => (await detail(page, r.id)).medicalLocation).toBeNull();
  });

  test('offline: the chip needs a connection (no sheet)', async ({ page, context }) => {
    const r = await inMedical(page, await createRequest(page));
    await page.goto('/?view=pending');
    await tab(page, 'Friend coming').click();
    const chip = comingCard(page, r.id).getByTestId('location-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await context.setOffline(true);
    try {
      await expect(page.getByTestId('connection-indicator')).toHaveAttribute('data-state', 'offline', { timeout: 15_000 });
      await expect(chip).toHaveAttribute('aria-disabled', 'true');
      await chip.click({ force: true });
      await expect(page.locator('.lp-toast').filter({ hasText: 'Needs a connection' })).toBeVisible();
      await expect(page.getByTestId('location-form')).toHaveCount(0);
    } finally {
      await context.setOffline(false);
    }
  });

  test('the request: "who · when" only, then the location row that adds and edits it', async ({ page }) => {
    const r = await inMedical(page, await createRequest(page));
    await page.goto(`/?r=${r.id}`);
    const block = page.getByTestId('status-block');
    await expect(block).toContainText('In medical · friend coming');
    await expect(block).toContainText(STAFF.staffName);
    await expect(block).not.toContainText('heading');
    await expect(block).not.toContainText(`${TAG} Friend`);
    const rowButton = block.getByTestId('location-row');
    await expect(rowButton).toHaveAccessibleName('Add location');
    await rowButton.click();
    const sheet = page.getByRole('dialog', { name: `${nameOf(r)} is in medical` });
    await sheet.getByRole('textbox', { name: 'Location' }).fill('Bed 4');
    await sheet.getByRole('button', { name: 'Save' }).click();
    await expect(rowButton).toHaveAccessibleName('Bed 4, edit location');
    await expect(rowButton).toContainText('Bed 4');
    await expect(page.getByTestId('audit-item').first()).toContainText('Edited Location');
    await expect(page.getByTestId('audit-item').first()).toContainText('Bed 4');
  });
});

test.describe('desk 1440 × 900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('both queues side by side; In medical opens the popover at the card; J / K walk To check, then Friend coming', async ({ page }) => {
    const waiting = await createRequest(page);
    const coming = await inMedical(page, await createRequest(page), 'Chair 5');
    await page.goto('/?view=pending');
    const board = page.getByTestId('pending-board');
    await expect(board).toBeVisible();
    await expect(checkCard(page, waiting.id)).toBeVisible({ timeout: 15_000 });
    await expect(comingCard(page, coming.id)).toBeVisible();

    // Two columns, To check on the left, no segmented control.
    await expect(page.getByTestId('pending-tabs')).toBeHidden();
    const left = (await page.getByTestId('pending-column-check').boundingBox())!;
    const right = (await page.getByTestId('pending-column-coming').boundingBox())!;
    expect(right.x).toBeGreaterThan(left.x + left.width);
    expect(Math.abs(right.y - left.y)).toBeLessThan(2);
    await expect(page.getByRole('heading', { level: 2, name: /^To check \d+$/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /^Friend coming \d+$/ })).toBeVisible();

    // J walks every card on screen: all of To check before Friend coming.
    const order = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-desk-main] [data-request-id]'))
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => el.closest('[data-pending-card]')?.getAttribute('data-testid')),
    );
    expect(order.lastIndexOf('check-card')).toBeLessThan(order.indexOf('friend-coming-card'));
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('j');
    await expect(page.locator('[data-desk-main] [data-request-id]').first()).toBeFocused();

    // In medical: saved at once; the popover opens where the tapped card was (the card itself moves on to
    // the end of Friend coming), under it, in the To check column.
    await checkCard(page, waiting.id).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const tapped = (await checkCard(page, waiting.id).boundingBox())!;
    await checkCard(page, waiting.id).getByRole('button', { name: 'In medical', exact: true }).click();
    const pop = page.getByRole('dialog', { name: `${nameOf(waiting)} is in medical` });
    await expect(pop).toBeVisible();
    await expect(comingCard(page, waiting.id)).toHaveCount(1);
    await expect(pop.getByRole('textbox', { name: 'Location' })).toBeFocused();
    const box = (await pop.boundingBox())!;
    expect(Math.abs(box.x - tapped.x)).toBeLessThan(2);
    expect(box.x + box.width).toBeLessThan(right.x);
    // Under the card, or above it when the card is at the foot of the window; always on screen.
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
    // Shortcuts are off while it is open: N types into the field instead of opening New request.
    await page.keyboard.type('Next to N');
    await expect(page).not.toHaveURL(/new=1/);
    await page.keyboard.press('Enter');
    await expect(pop).toHaveCount(0);
    await expect(comingCard(page, waiting.id).getByTestId('location-chip')).toHaveAccessibleName('Next to N, edit location');
    await expect.poll(async () => (await detail(page, waiting.id)).medicalLocation).toBe('Next to N');
  });

  test('a docked request narrows the board into the tabs; the pane edits the location in a popover', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    const waiting = await createRequest(page);
    const coming = await inMedical(page, await createRequest(page));
    await page.goto('/?view=pending');
    await expect(checkCard(page, waiting.id)).toBeVisible({ timeout: 15_000 });
    // 1180 with nothing open: still two columns.
    await expect(page.getByTestId('pending-tabs')).toBeHidden();
    await expect(comingCard(page, coming.id)).toBeVisible();

    await comingCard(page, coming.id).locator('[data-request-id]').click();
    const pane = page.getByTestId('profile');
    await expect(pane.getByTestId('location-row')).toBeVisible();
    // Docked beside a 700 px main column: one queue at a time, under the control.
    await expect(page.getByTestId('pending-tabs')).toBeVisible();
    await expect(page.getByTestId('pending-column-coming')).toBeHidden();
    await tab(page, 'Friend coming').click();
    await expect(page.getByTestId('pending-column-check')).toBeHidden();
    await expect(comingCard(page, coming.id)).toBeVisible();

    await pane.getByTestId('location-row').click();
    const pop = page.getByRole('dialog', { name: `${nameOf(coming)} is in medical` });
    await expect(pop).toBeVisible();
    await pop.getByRole('textbox', { name: 'Location' }).fill('Chair 30');
    // Esc closes the popover only (the request stays open), and saves nothing.
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(pane).toBeVisible();
    await expect(pane.getByTestId('location-row')).toHaveAccessibleName('Add location');
    await pane.getByTestId('location-row').click();
    await pop.getByRole('textbox', { name: 'Location' }).fill('Chair 30');
    await pop.getByRole('button', { name: 'Save' }).click();
    await expect(pane.getByTestId('location-row')).toHaveAccessibleName('Chair 30, edit location');
    await expect(comingCard(page, coming.id).getByTestId('location-chip')).toHaveAccessibleName('Chair 30, edit location');
  });
});

test.describe('iPad portrait 820 × 1180', () => {
  test.use({ viewport: { width: 820, height: 1180 }, isMobile: false, hasTouch: true, deviceScaleFactor: 1 });

  test('two columns beside the rail', async ({ page }) => {
    const waiting = await createRequest(page);
    const coming = await inMedical(page, await createRequest(page));
    await page.goto('/?view=pending');
    await expect(page.getByTestId('desk-rail')).toBeVisible();
    await expect(checkCard(page, waiting.id)).toBeVisible({ timeout: 15_000 });
    await expect(comingCard(page, coming.id)).toBeVisible();
    await expect(page.getByTestId('pending-tabs')).toBeHidden();
    const left = (await page.getByTestId('pending-column-check').boundingBox())!;
    const right = (await page.getByTestId('pending-column-coming').boundingBox())!;
    expect(right.x).toBeGreaterThan(left.x + left.width);
    expect(left.width).toBeGreaterThan(320);
  });
});
