import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { CreateResponse, RequestDetail, RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { axeViolations, overlappingTargets, smallTargets } from './helpers/a11y';
import { signedInAs } from './helpers/session';

// Desk shell (components/desk; design/screens/desktop-log.html, desktop-new-tablet.html): the sidebar or
// icon rail, the top bar, the request docked beside the list (a sheet over it on iPad portrait), and the
// keyboard: "/" search, N new request, J/K and the arrows, Enter, Esc. Under 768 px the phone app is
// unchanged. Synthetic rows only (TEST-shell-e2e-…), closed afterwards.

const BASE = testBaseUrl();
const STAFF = { staffName: 'TEST-shell Desk', team: 'GC/HX - Dispatch' };
const TAG = `TEST-shell-e2e-${Date.now().toString(36)}`;

test.use({ bypassCSP: true, serviceWorkers: 'block' });
signedInAs(STAFF);

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function api<T>(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

/** Each test's own tag, so a search never finds another test's rows (cancelled rows stay searchable). */
let tagSeq = 0;
const nextTag = () => `${TAG}-t${(tagSeq += 1)}x`;

async function createRequests(page: Page, n: number, tag: string = nextTag()): Promise<RequestSummary[]> {
  const rows: RequestSummary[] = [];
  for (let i = 1; i <= n; i += 1) {
    const { request } = await api<CreateResponse>(page.request, 'POST', '/api/requests', {
      clientMutationId: randomUUID(),
      reportingLocation: 'FA 3 – Kinetic',
      name: `${tag} P${i}`,
      age: 20 + i,
      gender: 'Female',
      clothing: `Synthetic ${tag} jacket ${i}`,
      lastSeen: 'kineticFIELD rail',
      contactName: `${tag} Friend`,
      contactPhone: '(407) 555-0142',
      contactRelationship: 'Friend',
    });
    created.push({ id: request.id, request: page.request });
    rows.push(request);
  }
  return rows;
}

test.afterEach(async () => {
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await api<RequestDetail>(request, 'GET', `/api/requests/${id}`);
      if (row.status === 'Added') {
        await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: BASE } });
      }
    } catch {
      // Best effort.
    }
  }
});

const main = (page: Page) => page.locator('[data-desk-main]');
const row = (page: Page, id: string) => page.locator(`[data-desk-main] [data-request-id="${id}"]`).first();
const paramOf = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);

/** Request ids in the order the main column shows them (what J / K walk through). */
async function rowOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const ids: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-desk-main] [data-request-id]'))) {
      const id = el.dataset.requestId;
      if (id && !ids.includes(id) && el.getClientRects().length > 0) ids.push(id);
    }
    return ids;
  });
}

/** The docked pane's column: what is right of the main column (the pane plus its 1 px border). */
async function paneColumn(page: Page): Promise<number> {
  const box = (await main(page).boundingBox())!;
  return page.viewportSize()!.width - (box.x + box.width);
}

const activeRowId = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.requestId ?? null);

async function openSearchResults(page: Page, tag: string) {
  await page.goto(`/?q=${encodeURIComponent(tag)}`);
  await expect(main(page).locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
}

test.describe('desktop 1440 × 900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('sidebar, top bar and a request docked beside the list; J/K, Esc back to the row', async ({ page }) => {
    const tag = nextTag();
    const rows = await createRequests(page, 3, tag);
    await openSearchResults(page, tag);

    // Sidebar (not the rail), the top bar, and no phone chrome inside the main column.
    const sidebar = page.getByTestId('desk-sidebar');
    await expect(sidebar).toBeVisible();
    await expect(page.getByTestId('desk-rail')).toBeHidden();
    // The sidebar column is 232 px: the main column starts there.
    expect((await main(page).boundingBox())?.x).toBeCloseTo(232, 0);
    for (const name of [/^All requests \d+$/, /^Pending \d+$/, /^My requests \d+$/, /^Dashboard$/]) {
      await expect(sidebar.getByRole('link', { name })).toBeVisible();
    }
    await expect(sidebar.getByRole('switch', { name: 'Alerts' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Search requests' })).toHaveValue(tag);
    await expect(page.getByRole('button', { name: /^New request/ })).toHaveCount(1);
    // The Search view's own field (phone chrome) is hidden: the top bar's field drives it.
    await expect(page.locator('[data-desk-main] [data-view="search"] form[role="search"]')).toBeHidden();
    await expect(page.getByTestId('view-switcher')).toBeHidden();

    // Open the first result: it docks on the right (452 px), the list stays, the row is highlighted.
    const order = await rowOrder(page);
    const ours = rows.map((r) => r.id);
    expect(order.filter((id) => ours.includes(id)).length).toBe(3);
    const first = order[0]!;
    await row(page, first).click();
    await expect.poll(() => paramOf(page, 'r')).toBe(first);
    const pane = page.getByTestId('desk-pane');
    await expect(pane).toBeVisible();
    await expect(page.getByTestId('profile')).toBeVisible();
    expect(await paneColumn(page)).toBeCloseTo(452, 0);
    await expect(page.getByTestId('desk-pane-case')).toHaveText(/^LP-\d{4}$/);
    await expect(row(page, order[1]!)).toBeVisible();
    await expect(row(page, first)).not.toHaveCSS('box-shadow', 'none');
    // The profile's own top bar is the pane's now.
    await expect(page.getByTestId('profile-case')).toBeHidden();
    await expect(page.getByTestId('desk-prev')).toBeDisabled();

    // J / K and the arrows walk the main column's order; the open request follows.
    await page.keyboard.press('j');
    await expect.poll(() => paramOf(page, 'r')).toBe(order[1]);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => paramOf(page, 'r')).toBe(order[2]);
    await page.keyboard.press('k');
    await expect.poll(() => paramOf(page, 'r')).toBe(order[1]);
    await page.getByTestId('desk-prev').click();
    await expect.poll(() => paramOf(page, 'r')).toBe(first);

    // Esc closes it, back to the same list, and the focus returns to the row.
    await page.keyboard.press('Escape');
    await expect(pane).toHaveCount(0);
    expect(paramOf(page, 'r')).toBeNull();
    expect(paramOf(page, 'q')).toBe(tag);
    await expect.poll(() => activeRowId(page)).toBe(first);

    // With nothing open, J moves the selection (focus) and Enter opens it.
    await page.keyboard.press('j');
    await expect.poll(() => activeRowId(page)).toBe(order[1]);
    await page.keyboard.press('Enter');
    await expect.poll(() => paramOf(page, 'r')).toBe(order[1]);
    await page.getByTestId('desk-close').click();
    await expect(pane).toHaveCount(0);
    await expect.poll(() => activeRowId(page)).toBe(order[1]);
  });

  test('"/" searches, N opens New request, keys never fire while typing; the sidebar switches views', async ({ page }) => {
    const tag = nextTag();
    await createRequests(page, 1, tag);
    await page.goto('/');
    await expect(main(page).locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { level: 1, name: /^All requests \d+$/ })).toBeVisible();
    await expect(page.getByTestId('desk-sidebar').getByRole('link', { name: /^All requests/ })).toHaveAttribute('aria-current', 'page');
    // The list's phone chrome (its title row, view switcher, floating New request) is the shell's here.
    await expect(page.getByTestId('view-switcher')).toBeHidden();
    await expect(page.getByTestId('live-dot')).toBeHidden();

    // "/" focuses the field; typing opens Search; N and J are just letters there.
    await page.locator('body').press('/');
    const field = page.getByRole('searchbox', { name: 'Search requests' });
    await expect(field).toBeFocused();
    await page.keyboard.type(tag.slice(0, -1));
    await page.keyboard.type('n');
    await expect(field).toHaveValue(`${tag.slice(0, -1)}n`);
    expect(paramOf(page, 'new')).toBeNull();
    await field.fill(tag);
    await expect.poll(() => paramOf(page, 'q')).toBe(tag);
    await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
    await expect(main(page).locator('[data-request-id]')).toHaveCount(1);
    // Esc clears, then leaves search.
    await field.press('Escape');
    await expect(field).toHaveValue('');
    await field.press('Escape');
    await expect.poll(() => paramOf(page, 'q')).toBeNull();
    await expect(page.getByRole('heading', { level: 1, name: /^All requests/ })).toBeVisible();

    // N opens New request over the desk; the sidebar is inert behind it; Cmd+N is left to the browser.
    await page.locator('body').press('Meta+n').catch(() => undefined);
    expect(paramOf(page, 'new')).toBeNull();
    await page.locator('body').press('n');
    await expect.poll(() => paramOf(page, 'new')).toBe('1');
    await expect(page.getByTestId('request-form-submit')).toBeVisible();
    // Nothing behind the form can be reached: inert while the form covers the desk in place, hidden from
    // assistive tech (and outside the focus trap) under a form that opens as a dialog.
    await expect.poll(() => page.getByTestId('desk-sidebar').evaluate((el) => !!el.closest('[inert], [aria-hidden="true"]'))).toBe(true);
    await page.goBack();
    await expect.poll(() => paramOf(page, 'new')).toBeNull();

    // Closing the form gives the focus back to where it was before it opened.
    await page.getByTestId('desk-new').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => paramOf(page, 'new')).toBe('1');
    await expect(page.getByTestId('request-form-submit')).toBeVisible();
    await page.goBack();
    await expect.poll(() => paramOf(page, 'new')).toBeNull();
    await expect(page.getByTestId('desk-new')).toBeFocused();

    // The sidebar switches views in place.
    await page.getByTestId('desk-sidebar').getByRole('link', { name: /^Pending/ }).click();
    await expect.poll(() => paramOf(page, 'view')).toBe('pending');
    await expect(page.getByRole('heading', { level: 1, name: /^Pending \d+$/ })).toBeVisible();
    await expect(page.getByTestId('desk-sidebar').getByRole('link', { name: /^Pending/ })).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('desk-sidebar').getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

    // Alerts (the phone's bell) and the account menu (the phone's avatar menu).
    const alerts = page.getByTestId('desk-sidebar').getByRole('switch', { name: 'Alerts' });
    await expect(alerts).toHaveAttribute('aria-checked', 'false');
    await alerts.click();
    await expect(alerts).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('dialog', { name: 'Alerts are on' })).toBeVisible();
    await page.getByRole('button', { name: 'Got it' }).click();
    await page.getByTestId('desk-sidebar').getByTestId('account-trigger').click();
    const menu = page.getByRole('dialog', { name: 'Account' });
    await expect(menu).toBeVisible();
    for (const item of ['Dashboard', 'Export CSV', 'Sign out']) await expect(menu.getByText(item, { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`passes axe with a request open (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('lp-theme', t);
        } catch {
          // ignore
        }
      }, theme);
      const [one] = await createRequests(page, 1);
      await page.goto(`/?r=${one!.id}`);
      await expect(page.getByTestId('desk-pane')).toBeVisible({ timeout: 15_000 });
      await expect(row(page, one!.id)).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(400);
      expect(await axeViolations(page)).toEqual([]);
    });
  }
});

test.describe('iPad landscape 1180 × 820 (touch)', () => {
  test.use({ viewport: { width: 1180, height: 820 }, isMobile: false, hasTouch: true, deviceScaleFactor: 1 });

  test('icon rail; the request docks at 420 px; 44 px targets that never overlap', async ({ page }) => {
    const [one] = await createRequests(page, 1);
    await page.goto('/');
    await expect(main(page).locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
    const rail = page.getByTestId('desk-rail');
    await expect(rail).toBeVisible();
    await expect(page.getByTestId('desk-sidebar')).toBeHidden();
    expect((await main(page).boundingBox())?.x).toBeCloseTo(60, 0);
    await expect(rail.getByRole('link', { name: /^Pending( \d+)?$/ })).toBeVisible();

    await page.goto(`/?r=${one!.id}`);
    const pane = page.getByTestId('desk-pane');
    await expect(pane).toBeVisible({ timeout: 15_000 });
    expect(await paneColumn(page)).toBeCloseTo(420, 0);
    // A narrow main column: the search icon and "New" (desktop-new-tablet.html, iPad landscape).
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Search requests' })).toBeHidden();
    await expect.poll(async () => (await page.getByTestId('desk-new').innerText()).trim()).toBe('New');
    await expect(page.getByTestId('desk-new')).toHaveAccessibleName('New');

    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    test.skip(!coarse, 'this browser does not report a coarse pointer for touch emulation');
    for (const scope of ['[data-testid="desk-rail"]', '[data-testid="desk-topbar"]', '[data-testid="desk-pane"] header']) {
      expect(await smallTargets(page, scope), scope).toEqual([]);
      expect(await overlappingTargets(page, scope), scope).toEqual([]);
    }
  });
});

test.describe('iPad portrait 820 × 1180 (touch)', () => {
  test.use({ viewport: { width: 820, height: 1180 }, isMobile: false, hasTouch: true, deviceScaleFactor: 1 });

  test('the request is a 480 px sheet over the list, which stays visible and usable', async ({ page }) => {
    const tag = nextTag();
    const rows = await createRequests(page, 2, tag);
    await openSearchResults(page, tag);
    await expect(page.getByTestId('desk-rail')).toBeVisible();
    // Room for the full top bar: the search field with "/" and "New request" (desktop-new-tablet.html).
    await expect(page.getByRole('searchbox', { name: 'Search requests' })).toBeVisible();
    await expect.poll(async () => (await page.getByTestId('desk-new').innerText()).replace(/\s+/g, ' ').trim()).toBe('New request N');

    const order = await rowOrder(page);
    const before = await main(page).boundingBox();
    await row(page, order[0]!).click();
    const pane = page.getByTestId('desk-pane');
    await expect(pane).toBeVisible();
    const box = (await pane.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(480);
    expect(box.width).toBeGreaterThan(400);
    // Over the list: the main column keeps its width, and its left side is still the list (no scrim).
    expect((await main(page).boundingBox())?.width).toBe(before?.width);
    const second = row(page, order[1]!);
    const target = await second.boundingBox();
    const hit = await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y)?.closest('[data-request-id]') as HTMLElement | null)?.dataset.requestId ?? null, {
      x: target!.x + 24,
      y: target!.y + target!.height / 2,
    });
    expect(hit).toBe(order[1]);
    await second.click({ position: { x: 24, y: target!.height / 2 } });
    await expect.poll(() => paramOf(page, 'r')).toBe(order[1]);
    expect(rows.map((r) => r.id)).toContain(order[1]);
  });
});

test.describe('phone 390 × 844', () => {
  test('unchanged: no desk chrome, and a request is the full screen with nothing behind it', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-iphone14' && testInfo.project.name !== 'webkit-iphone14', 'phone projects only');
    const [one] = await createRequests(page, 1);
    await page.goto('/');
    await expect(page.locator('[data-request-id]').first()).toBeVisible({ timeout: 15_000 });
    for (const id of ['desk-sidebar', 'desk-rail', 'desk-topbar']) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.getByTestId('view-switcher')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New request' })).toBeVisible();

    await page.goto(`/?r=${one!.id}`);
    await expect(page.getByTestId('profile-case')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('desk-pane')).toHaveCount(0);
    await expect(page.locator('[data-request-id]')).toHaveCount(0);
    // Keys are a desk feature.
    await page.locator('body').press('n');
    expect(paramOf(page, 'new')).toBeNull();
  });
});
