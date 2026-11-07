import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { RequestDetail, RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { signedInAs } from './helpers/session';

// Pending v8 (design/screens/pending-v8.html, Brian + Dani 2026-11-06 afternoon) with Pending v9.1 (Brian
// 2026-11-06 evening, design/screens/pending-v9.html; tests/e2e/pending-v9.spec.ts has the rest), end to end on
// the real store, API and database:
//   phone  one page, Waiting for check then Friend coming (no tabs); the v8 cards (no friend line since v9.1);
//          In medical saves at once and then asks where they are (bottom sheet: Save, Skip, Esc or a swipe
//          down); the Friend coming chip edits the location; the request's status block shows it.
//   desk   both queues side by side (stacking into one column when the main column is narrow); the location
//          popover at the card; J / K walk Waiting for check, then Friend coming.
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
  test('one page: Waiting for check, then Friend coming with where medical has them (no tabs, no friend line)', async ({ page }) => {
    const waiting = await createRequest(page);
    const located = await inMedical(page, await createRequest(page), 'Chair 3');
    const unlocated = await inMedical(page, await createRequest(page, { contactRelationship: null }));
    await page.goto('/?view=pending');
    await expect(checkCard(page, waiting.id)).toBeVisible({ timeout: 15_000 });

    // No brand card; the large title, then the Waiting for check section, then Friend coming. No tabs.
    await expect(page.getByTestId('brand-card')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(0);
    const title = (await page.getByTestId('view-switcher').boundingBox())!;
    const check = (await page.getByTestId('queue-header-check').boundingBox())!;
    const coming = (await page.getByTestId('queue-header-coming').boundingBox())!;
    expect(check.y).toBeGreaterThan(title.y + title.height - 1);
    expect(coming.y).toBeGreaterThan(check.y);
    await expect(comingCard(page, located.id)).toBeVisible();

    // The Waiting for check card: no photo placeholder, "FA 3 · LP-…", both answers at 44 px.
    const card = checkCard(page, waiting.id);
    await expect(card.getByTestId('card-photo')).toHaveCount(0);
    await expect(card).toContainText(`FA 3 · LP-${String(waiting.caseNumber).padStart(4, '0')}`);
    for (const answer of [card.getByTestId('not-found-answer'), card.getByRole('button', { name: 'In medical', exact: true })]) {
      expect((await answer.boundingBox())!.height).toBeCloseTo(44, 0);
    }

    await expect(comingCard(page, located.id).getByTestId('location-chip')).toHaveAccessibleName('Chair 3, edit location');
    await expect(comingCard(page, located.id)).not.toContainText(`${TAG} Friend`);
    await expect(comingCard(page, located.id)).not.toContainText('boyfriend');
    await expect(comingCard(page, unlocated.id).getByTestId('location-chip')).toHaveAccessibleName('Add location');
    await expect(comingCard(page, unlocated.id).getByRole('button', { name: 'Reunited' })).toBeVisible();
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
    await expect(comingCard(page, r.id).getByTestId('location-chip')).toHaveAccessibleName('Chair 12, edit location');

    // The Undo from the answer is still there and still works; the location stays on the request.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(comingCard(page, r.id)).toHaveCount(0);
    await expect.poll(async () => (await detail(page, r.id)).status).toBe('Added');
    expect((await detail(page, r.id)).medicalLocation).toBe('Chair 12');
    const audit = (await detail(page, r.id)).audit.filter((e) => e.action === 'edit');
    expect(audit.map((e) => e.next)).toEqual([{ medicalLocation: 'Chair 12' }]);
  });

  test('a slow location keeps the In medical Undo: held while the sheet covers it, then a full 10 s from Save', async ({ page }) => {
    const r = await createRequest(page);
    await page.goto('/?view=pending');
    await expect(checkCard(page, r.id)).toBeVisible({ timeout: 15_000 });
    await checkCard(page, r.id).getByRole('button', { name: 'In medical', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: `${nameOf(r)} is in medical` });
    await expect(sheet).toBeVisible();
    await expect.poll(async () => (await detail(page, r.id)).status).toBe('Found – Awaiting Reunion');
    // Longer than the 10 s Undo before the location is typed and saved.
    await page.waitForTimeout(11_000);
    await sheet.getByRole('textbox', { name: 'Location' }).fill('Chair 9');
    await sheet.getByRole('button', { name: 'Save' }).click();
    await expect(sheet).toHaveCount(0);
    const undo = page.getByRole('button', { name: 'Undo' });
    await expect(undo).toBeVisible();
    await expect.poll(async () => (await detail(page, r.id)).medicalLocation).toBe('Chair 9');
    // Most of a full window after the sheet closed, it is still there and still one tap.
    await page.waitForTimeout(7_000);
    await undo.click();
    await expect.poll(async () => (await detail(page, r.id)).status).toBe('Added');
    expect((await detail(page, r.id)).medicalLocation).toBe('Chair 9');
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

  // (Hotfix F5.1, Brian 2026-11-07) The sheet on the iPhone keyboard. Playwright shows no keyboard, so
  // window.visualViewport is a fake the test sizes and pans as a phone does: the keyboard alone, a pan to the
  // field, and iOS 26 Safari's visible area running past the layout viewport's bottom. The sheet's bottom is the
  // keyboard's top, the scrim covers everything else on screen, the page behind never moves, and when the field
  // lets go of the focus the sheet goes back down at once; Skip leaves the page where it was.
  test('the sheet sits on the keyboard: flush on it, the scrim over the rest, the page pinned; back down when the field lets go', async ({ page }) => {
    await page.addInitScript(() => {
      const vv = Object.assign(new EventTarget(), { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
      Object.assign(window, {
        __lpViewport: (box: { offsetTop: number; height: number }) => {
          Object.assign(vv, box);
          vv.dispatchEvent(new Event('resize'));
          vv.dispatchEvent(new Event('scroll'));
        },
      });
    });
    const viewport = (box: { offsetTop: number; height: number }) =>
      page.evaluate((b) => (window as unknown as { __lpViewport: (b: unknown) => void }).__lpViewport(b), box);
    // Enough cards for the page to scroll; the last one (the newest) is answered.
    const rows = [];
    for (let i = 0; i < 6; i += 1) rows.push(await createRequest(page));
    const r = rows.at(-1)!;
    await page.goto('/?view=pending');
    const card = checkCard(page, r.id);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 120));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const ref = page.locator('[data-testid="check-card"]').first();
    const refTop = async () => (await ref.boundingBox())!.y;

    await card.getByRole('button', { name: 'In medical', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: `${nameOf(r)} is in medical` });
    const field = sheet.getByRole('textbox', { name: 'Location' });
    await expect(field).toBeFocused();
    const height = page.viewportSize()!.height;
    const geometry = () =>
      page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('.lp-sheet')!;
        const overlay = el.closest<HTMLElement>('.rt-BaseDialogOverlay')!;
        const o = overlay.getBoundingClientRect();
        const scrim = getComputedStyle(overlay, '::before');
        return {
          top: el.getBoundingClientRect().top,
          bottom: el.getBoundingClientRect().bottom,
          kb: overlay.hasAttribute('data-kb'),
          scrimTop: o.top + parseFloat(scrim.top),
          scrimBottom: o.bottom - parseFloat(scrim.bottom),
          body: getComputedStyle(document.body).position,
        };
      });
    // The page is pinned as soon as the field has the focus.
    await expect.poll(async () => (await geometry()).body).toBe('fixed');
    const before = await refTop();

    for (const box of [
      { offsetTop: 0, height: height - 300 }, // the keyboard
      { offsetTop: 120, height: height - 300 }, // the phone panned to the field
      { offsetTop: 364, height: height - 300 }, // iOS 26 Safari: 64 px past the layout viewport's bottom
    ]) {
      const vvBottom = box.offsetTop + box.height;
      await viewport(box);
      await expect.poll(async () => Math.round((await geometry()).bottom), JSON.stringify(box)).toBe(vvBottom);
      const g = await geometry();
      expect(g.kb).toBe(true);
      expect(g.scrimTop).toBeLessThanOrEqual(box.offsetTop);
      expect(g.scrimBottom).toBeGreaterThanOrEqual(vvBottom);
      // On screen above the sheet: the scrim (inside the dialog's overlay, outside the sheet), never the page.
      const hit = await page.evaluate(
        (ys: number[]) =>
          ys.map((at) => {
            const el = document.elementFromPoint(195, at);
            return el?.closest('.lp-sheet') ? 'sheet' : el?.closest('.rt-BaseDialogOverlay') ? 'scrim' : 'page';
          }),
        [Math.max(box.offsetTop + 2, 2), Math.min(vvBottom, height) - 2],
      );
      expect(hit, JSON.stringify(box)).toEqual(['scrim', 'sheet']);
      // The page behind doesn't scroll.
      await page.evaluate(() => {
        window.scrollBy(0, 200);
        document.scrollingElement?.scrollBy(0, 200);
      });
      expect(await refTop()).toBeCloseTo(before, 0);
    }

    // The keyboard goes (the field lets go of the focus): the sheet is back at the bottom at once, before the
    // phone reports it, and stays there.
    await field.blur();
    await expect.poll(async () => (await geometry()).kb).toBe(false);
    await expect.poll(async () => Math.round((await geometry()).bottom)).toBe(height);
    await viewport({ offsetTop: 0, height });
    expect(Math.round((await geometry()).bottom)).toBe(height);

    // Skip: the page is where it was.
    await sheet.getByRole('button', { name: 'Skip' }).click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).position)).not.toBe('fixed');
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(await refTop()).toBeCloseTo(before, 0);
  });
});

test.describe('desk 1440 × 900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('both queues side by side; In medical opens the popover at the card; J / K walk Waiting for check, then Friend coming', async ({ page }) => {
    const waiting = await createRequest(page);
    const coming = await inMedical(page, await createRequest(page), 'Chair 5');
    await page.goto('/?view=pending');
    const board = page.getByTestId('pending-board');
    await expect(board).toBeVisible();
    await expect(checkCard(page, waiting.id)).toBeVisible({ timeout: 15_000 });
    await expect(comingCard(page, coming.id)).toBeVisible();

    // Two columns, Waiting for check on the left, no segmented control.
    await expect(page.getByTestId('pending-tabs')).toHaveCount(0);
    const left = (await page.getByTestId('pending-column-check').boundingBox())!;
    const right = (await page.getByTestId('pending-column-coming').boundingBox())!;
    expect(right.x).toBeGreaterThan(left.x + left.width);
    expect(Math.abs(right.y - left.y)).toBeLessThan(2);
    await expect(page.getByRole('heading', { level: 2, name: /^Waiting for check \d+ requests?$/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /^Friend coming \d+ requests?$/ })).toBeVisible();

    // J walks every card on screen: all of Waiting for check before Friend coming.
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
    // the end of Friend coming), under it, in the Waiting for check column.
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

  test('In medical from the keyboard: the popover hands the focus to the card that took its place; J / K carry on from it', async ({ page }) => {
    const a = await createRequest(page);
    const b = await createRequest(page);
    const c = await createRequest(page);
    await page.goto('/?view=pending');
    await expect(checkCard(page, c.id)).toBeVisible({ timeout: 15_000 });
    const openButton = (r: RequestSummary) => checkCard(page, r.id).locator('[data-request-id]');
    const answer = async (r: RequestSummary) => {
      await openButton(r).focus();
      await checkCard(page, r.id).getByRole('button', { name: 'In medical', exact: true }).focus();
      await page.keyboard.press('Enter');
      const pop = page.getByRole('dialog', { name: `${nameOf(r)} is in medical` });
      await expect(pop.getByRole('textbox', { name: 'Location' })).toBeFocused();
      return pop;
    };

    // Waiting for check is longest wait first: a, b, c are its last three. Esc: the focus is on b, which took a's place.
    let pop = await answer(a);
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(openButton(b)).toBeFocused();
    await page.keyboard.press('j');
    await expect(openButton(c)).toBeFocused();
    await page.keyboard.press('k');
    await expect(openButton(b)).toBeFocused();

    // The last card answered and its location saved: the focus goes to the one before it.
    pop = await answer(c);
    await page.keyboard.type('Chair 2');
    await page.keyboard.press('Enter');
    await expect(pop).toHaveCount(0);
    await expect(openButton(b)).toBeFocused();
    await expect.poll(async () => (await detail(page, c.id)).medicalLocation).toBe('Chair 2');

    // Skip, from the button: the same.
    pop = await answer(b);
    await pop.getByRole('button', { name: 'Skip' }).focus();
    await page.keyboard.press('Enter');
    await expect(pop).toHaveCount(0);
    // On a card again (the one before b, or one a sync added after it), once the popover has handed it back.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('[data-pending-card]')?.getAttribute('data-testid') ?? null))
      .not.toBeNull();
  });

  test('a docked request keeps the board in two columns (no tabs); the pane edits the location in a popover', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    const waiting = await createRequest(page);
    const coming = await inMedical(page, await createRequest(page));
    await page.goto('/?view=pending');
    await expect(checkCard(page, waiting.id)).toBeVisible({ timeout: 15_000 });
    // 1180 with nothing open: two columns.
    const side = (await page.getByTestId('pending-column-coming').boundingBox())!;
    expect(side.x).toBeGreaterThan((await page.getByTestId('pending-column-check').boundingBox())!.x + 100);
    await expect(comingCard(page, coming.id)).toBeVisible();

    await comingCard(page, coming.id).locator('[data-request-id]').click();
    const pane = page.getByTestId('profile');
    await expect(pane.getByTestId('location-row')).toBeVisible();
    // Docked beside a 700 px main column: still Waiting for check | Friend coming side by side (Pending v9.1
    // SPEC rule 5: two columns from 768 px, no stacked fallback); no tabs.
    await expect(page.getByTestId('pending-tabs')).toHaveCount(0);
    const left = (await page.getByTestId('pending-column-check').boundingBox())!;
    const right = (await page.getByTestId('pending-column-coming').boundingBox())!;
    expect(right.x).toBeGreaterThan(left.x + left.width);
    expect(Math.abs(right.y - left.y)).toBeLessThan(2);
    // The open request's card is scrolled into view when it opens (PendingView follows the pane).
    await expect(comingCard(page, coming.id)).toBeInViewport();

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

test.describe('iPad landscape 1180 × 820', () => {
  test.use({ viewport: { width: 1180, height: 820 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('a Friend coming card opened beside the board: the stacked board keeps it on screen, J / K walk Friend coming', async ({ page }) => {
    await createRequest(page);
    const first = await inMedical(page, await createRequest(page));
    const second = await inMedical(page, await createRequest(page));
    await page.goto('/?view=pending');
    await expect(comingCard(page, second.id)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('pending-tabs')).toHaveCount(0);
    await comingCard(page, first.id).locator('[data-request-id]').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(first.id);
    await expect(page.getByTestId('desk-pane')).toBeVisible();
    // (Pending v9.1) Docked: the board stacks into one column (no tabs) and the open request's card stays on screen.
    await expect(page.getByTestId('pending-tabs')).toHaveCount(0);
    await expect(comingCard(page, first.id)).toBeInViewport();
    // J opens the next Friend coming card (nobody coming yet: longest since found first, so `second` is after
    // `first`); K back.
    await page.keyboard.press('j');
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(second.id);
    await expect(comingCard(page, second.id)).toBeInViewport();
    await expect(page.getByTestId('desk-prev')).toBeEnabled();
    await page.keyboard.press('k');
    await expect.poll(() => new URL(page.url()).searchParams.get('r')).toBe(first.id);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('desk-pane')).toHaveCount(0);
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
    await expect(page.getByTestId('pending-tabs')).toHaveCount(0);
    const left = (await page.getByTestId('pending-column-check').boundingBox())!;
    const right = (await page.getByTestId('pending-column-coming').boundingBox())!;
    expect(right.x).toBeGreaterThan(left.x + left.width);
    expect(left.width).toBeGreaterThan(320);
  });
});
