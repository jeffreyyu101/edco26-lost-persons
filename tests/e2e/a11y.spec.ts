import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ChangeResponse, CreateResponse, RequestDetail, RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { axeContrastUnder, axeViolations, brandContrast, overlappingTargets, smallTargets, type AxeFinding } from './helpers/a11y';
import { syntheticPng } from './helpers/png';
import { newSignedInContext, signedInAs } from './helpers/session';

// Accessibility gates (spec §7 Accessibility: "tap targets of 44 px or more", "contrast passes in both
// themes"; WCAG 2.5.3 label in name). Every view and its main states, in light and in dark:
//   * axe-core with the WCAG 2.0/2.1 A + AA rules finds nothing (contrast, names, roles, structure)
//   * every visible control's effective tap target (box + hit-area pseudo-element) is ≥ 44 × 44 px
// The production CSP refuses the injected axe script, so this context bypasses CSP (the CSP itself is
// covered by the security and smoke specs). Synthetic rows only (TEST-A-…), closed afterwards.

const BASE = testBaseUrl();
const STAFF = { staffName: 'TEST-A Audit', team: 'GC/HX - Dispatch' };
const TAG = `TEST-A-${Date.now().toString(36)}`;
let seq = 0;

test.use({ bypassCSP: true, serviceWorkers: 'block' });

async function api<T>(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function createRequest(page: Page, extra: Record<string, unknown> = {}): Promise<RequestSummary> {
  seq += 1;
  const { request } = await api<CreateResponse>(page.request, 'POST', '/api/requests', {
    clientMutationId: randomUUID(),
    reportingLocation: 'FA 3 – Kinetic',
    name: `${TAG} P${seq}`,
    age: 24,
    gender: 'Female',
    clothing: `Synthetic ${TAG} jacket ${seq}`,
    lastSeen: 'kineticFIELD rail',
    contactName: `${TAG} Friend`,
    contactPhone: '(407) 555-0142',
    contactRelationship: 'Friend',
    ...extra,
  });
  created.push({ id: request.id, request: page.request });
  return request;
}

async function setStatus(page: Page, row: RequestSummary, status: string, kind: string): Promise<RequestSummary> {
  const { request } = await api<ChangeResponse>(page.request, 'POST', `/api/requests/${row.id}/status`, {
    status,
    expectedVersion: row.rowVersion,
    kind,
  });
  return request;
}

test.afterEach(async () => {
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await api<RequestDetail>(request, 'GET', `/api/requests/${id}`);
      if (row.status === 'Added') {
        await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: BASE } });
      } else if (row.status === 'Found – Awaiting Reunion') {
        await request.fetch(`/api/requests/${id}/status`, {
          method: 'POST',
          data: { status: 'Reunited – Closed', expectedVersion: row.rowVersion, kind: 'reunite' },
          headers: { Origin: BASE },
        });
      }
    } catch {
      // Best effort.
    }
  }
});

/** No toast or sheet animation mid-flight when axe samples colours. */
async function settle(page: Page) {
  await page.waitForTimeout(400);
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
}

/** Cards open the profile through a transparent button stretched over them (components/list/cards.tsx). */
const STRETCHED = '[class*="_stretch"]';

interface Audit {
  view: string;
  axe: string[];
  small: string[];
  overlaps: string[];
}

async function audit(page: Page, view: string): Promise<Audit> {
  await settle(page);
  const line = (v: AxeFinding) => `${v.rule} · ${v.target} · ${v.summary}`;
  const axe = (await axeViolations(page)).map(line);
  // Card text sits under the stretched button: axe can only check its colours with the overlay out of the way.
  for (const v of await axeContrastUnder(page, STRETCHED)) if (!axe.includes(line(v))) axe.push(line(v));
  const small = (await smallTargets(page)).map((t) => `${t.name} ${t.width}×${t.height}`);
  const overlaps = (await overlappingTargets(page)).map((o) => `${o.from} → ${o.over}`);
  return { view, axe, small, overlaps };
}

const clean = (a: Audit): Audit => ({ view: a.view, axe: [], small: [], overlaps: [] });

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('lp-theme', t);
        } catch {
          // ignore
        }
      }, theme);
    });

    test(`sign-in steps pass axe and have 44 px targets (${theme})`, async ({ page }) => {
      const results: Audit[] = [];
      await page.goto('/signin');
      await expect(page.getByRole('heading', { name: 'Staff sign-in' })).toBeVisible();
      results.push(await audit(page, 'sign-in step 1'));

      await page.evaluate(() => localStorage.setItem('lp-identity', JSON.stringify({ name: 'TEST-A Dana Kim', team: 'GC/HX - Dispatch' })));
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Enter the event password' })).toBeVisible();
      results.push(await audit(page, 'sign-in step 2'));

      for (const r of results) expect.soft(r, r.view).toEqual(clean(r));
    });

    test.describe('signed in', () => {
      // Signed in once through POST /api/session (A17); the sign-in test above stays signed out.
      signedInAs(STAFF);

      test(`signed-in views pass axe and have 44 px targets (${theme})`, async ({ browser, context, page }) => {
        test.slow();
        const waiting = await createRequest(page);
        const answerMe = await createRequest(page);
        const coming = await setStatus(page, await createRequest(page), 'Found – Awaiting Reunion', 'answer');
        // (F5) One request on a "Not found yet" hold, and one answered Not found twice (final, closed).
        const held = await setStatus(page, await createRequest(page), 'Checked – Not Found', 'answer');
        await setStatus(page, await setStatus(page, await createRequest(page), 'Checked – Not Found', 'answer'), 'Checked – Not Found', 'answer');
        await setStatus(page, await setStatus(page, await createRequest(page), 'Found – Awaiting Reunion', 'answer'), 'Reunited – Closed', 'reunite');
        const other = await createRequest(page, { reportingLocation: 'Other', otherLocation: 'Base' });
        // (F3) In medical with me en route: my en route row is a button named by what it shows (WCAG 2.5.3).
        const walking = await setStatus(page, await createRequest(page), 'Found – Awaiting Reunion', 'answer');
        await api(page.request, 'POST', `/api/requests/${walking.id}/enroute`, { action: 'set', etaMinutes: 5 });
        // A photo, so the profile's portrait is a button (its name must start with the count it shows).
        const png = syntheticPng(64, 64);
        const upload = await page.request.post(`/api/requests/${waiting.id}/photos`, {
          headers: { Origin: BASE },
          multipart: {
            photoId: randomUUID(),
            timing: 'today',
            photo: { name: 'photo.png', mimeType: 'image/png', buffer: png },
            thumb: { name: 'thumb.png', mimeType: 'image/png', buffer: png },
          },
        });
        expect(upload.ok(), `photo upload → ${upload.status()}`).toBe(true);
        // (F3) Medical asks on two of them: unread counts and previews on the cards (Message buttons with a
        // badge), and someone else's bubble in the thread.
        const medic = await newSignedInContext(browser, { staffName: 'TEST-A Medic', team: 'Medical' });
        try {
          for (const id of [waiting.id, coming.id]) {
            await api(medic.request, 'POST', `/api/requests/${id}/messages`, { clientMutationId: randomUUID(), body: 'Any tattoos or marks?' });
          }
        } finally {
          await medic.close();
        }

        const results: Audit[] = [];
        const visit = async (url: string, view: string, ready: () => Promise<void>) => {
          await page.goto(url);
          await ready();
          results.push(await audit(page, view));
        };
        const row = (id: string) => page.locator(`[data-request-id="${id}"]`).first();

        // ---- Lists, header, menus and sheets
        await visit('/', 'All', () => expect(row(waiting.id)).toBeVisible({ timeout: 15_000 }));

        // The brand row: every text at 4.5:1 or more against every pixel behind it (axe can't judge text on
        // its gradient). The row is dark in both themes, so both runs measure the same row; then the same at
        // 1280 px, where the long dates sit beside the title.
        await expect
          .poll(() => page.getByTestId('brand-card').evaluate((el) => [...el.querySelectorAll('img')].every((img) => img.complete && img.naturalWidth > 0)))
          .toBe(true);
        expect.soft(await brandContrast(page), `brand row (${theme})`).toEqual([]);
        // From 768 px the desk shell draws the row above its top bar (its logos load lazily).
        await page.setViewportSize({ width: 1280, height: 800 });
        const deskBrand = page.getByTestId('desk-brand').getByTestId('brand-card');
        await expect(deskBrand).toBeVisible({ timeout: 10_000 });
        await expect
          .poll(() => deskBrand.evaluate((el) => [...el.querySelectorAll('img')].every((img) => img.complete && img.naturalWidth > 0)))
          .toBe(true);
        expect.soft(await brandContrast(page, deskBrand), `brand row, 1280 px desk (${theme})`).toEqual([]);
        await page.setViewportSize({ width: 390, height: 664 });

        // Log option B: the closed requests open in place under "Archived N", greyed (contrast, spec §7).
        await page.getByTestId('closed-fold').click();
        await expect(page.getByTestId('closed-rows')).toBeVisible();
        results.push(await audit(page, 'All, Archived open'));
        await page.getByTestId('closed-fold').click();

        await page.getByTestId('account-trigger').click();
        await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
        results.push(await audit(page, 'account menu'));

        // Alerts in the avatar menu opens the Alerts sheet (F4): named by its visible heading.
        await page.getByRole('dialog', { name: 'Account' }).getByTestId('alerts-menu').click();
        const alertsSheet = page.getByRole('dialog', { name: 'Alerts' });
        await expect(alertsSheet).toBeVisible();
        await expect(alertsSheet.getByRole('heading', { name: 'Alerts' })).toBeVisible();
        await expect(alertsSheet.getByRole('switch', { name: /New requests/ })).toBeVisible();
        results.push(await audit(page, 'Alerts sheet'));
        await page.keyboard.press('Escape');
        await expect(alertsSheet).toHaveCount(0);
        // The Activity sheet from the bell (F4).
        await page.getByTestId('activity-bell').click();
        const activity = page.getByRole('dialog', { name: 'Activity' });
        await expect(activity).toBeVisible();
        await expect(activity.getByTestId('activity-panel')).toBeVisible();
        results.push(await audit(page, 'Activity sheet'));
        await page.keyboard.press('Escape');
        await expect(activity).toHaveCount(0);

        await visit('/?view=pending', 'Pending', async () => {
          await expect(row(waiting.id)).toBeVisible({ timeout: 15_000 });
          await expect(page.locator(`[data-testid="check-card"]:has([data-request-id="${waiting.id}"])`).getByTestId('message-preview')).toBeVisible();
        });
        await page.locator(`[data-testid="check-card"]:has([data-request-id="${answerMe.id}"])`).getByTestId('not-found-answer').click();
        await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
        results.push(await audit(page, 'Pending + Undo snackbar'));
        // Pending v9.1: Friend coming (location chips) on the same page, its header folding it; the location sheet.
        await expect(row(coming.id)).toBeVisible();
        await page.getByTestId('queue-toggle-check').click();
        await expect(page.locator(`[data-testid="friend-coming-card"]:has([data-request-id="${coming.id}"])`).getByTestId('unread-badge')).toBeVisible();
        results.push(await audit(page, 'Pending, Friend coming'));
        await page.locator(`[data-testid="friend-coming-card"]:has([data-request-id="${coming.id}"])`).getByTestId('location-chip').click();
        await expect(page.getByTestId('location-form')).toBeVisible();
        results.push(await audit(page, 'location sheet'));
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('location-form')).toHaveCount(0);
        await page.getByTestId('queue-toggle-check').click();

        await visit('/?view=mine', 'My requests', async () => {
          await expect(row(coming.id)).toBeVisible({ timeout: 15_000 });
          await expect(page.locator(`[data-testid="mine-card"]:has([data-request-id="${coming.id}"])`).getByTestId('unread-badge')).toBeVisible();
        });
        await visit(`/?q=${encodeURIComponent(TAG)}`, 'Search', () => expect(row(waiting.id)).toBeVisible({ timeout: 15_000 }));
        await visit(`/?status=${encodeURIComponent('Checked – Not Found')}`, 'All, status filter', () => expect(page.getByTestId('status-chip')).toBeVisible());
        await visit(`/?post=${encodeURIComponent('Other:Base')}`, 'All, post filter', () => expect(row(other.id)).toBeVisible({ timeout: 15_000 }));

        // ---- New request: the form, the post picker, Last seen chips, the discard confirm
        await visit('/?new=1', 'New request', () => expect(page.getByTestId('request-form-submit')).toBeVisible());
        await page.getByRole('button', { name: /^Reporting from/ }).click();
        await expect(page.getByRole('dialog', { name: 'Reporting from' })).toBeVisible();
        results.push(await audit(page, 'post picker'));
        await page.keyboard.press('Escape');
        await page.getByRole('textbox', { name: 'Last seen' }).fill('rail');
        await expect(page.getByRole('button', { name: 'kineticFIELD' })).toBeVisible();
        results.push(await audit(page, 'Last seen chips'));
        await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
        await expect(page.getByRole('alertdialog')).toBeVisible();
        results.push(await audit(page, 'discard confirm'));

        // ---- Profile, its confirm, edit, dashboard
        await visit(`/?r=${waiting.id}`, 'Profile (waiting)', async () => {
          await expect(page.getByTestId('audit-item').first()).toBeVisible();
          await expect(page.getByRole('button', { name: '1 photo, open viewer' })).toBeVisible();
        });
        await page.getByRole('button', { name: 'Cancel request' }).click();
        await expect(page.getByRole('alertdialog')).toBeVisible();
        results.push(await audit(page, 'cancel confirm'));
        await page.getByRole('button', { name: 'Keep' }).click();
        await visit(`/?r=${coming.id}`, 'Profile (in medical)', async () => {
          await expect(page.getByTestId('audit-item').first()).toBeVisible();
          await expect(page.getByTestId('messages').getByTestId('bubble-them')).toBeVisible({ timeout: 15_000 });
        });
        await visit(`/?r=${held.id}`, 'Profile (not found yet)', () => expect(page.getByTestId('recheck-row')).toBeVisible());
        await visit(`/?r=${walking.id}`, 'Profile (my en route)', async () => {
          const mine = page.getByTestId('status-block').getByRole('button', { name: /^Friend en route ~\d+ min$/ });
          await expect(mine).toBeVisible({ timeout: 15_000 });
          await expect(mine).toHaveAccessibleDescription(/^Friend en route, about \d+ min away\. Change or cancel yours\.$/);
        });
        await visit(`/?r=${waiting.id}&edit=all`, 'Edit', () => expect(page.getByTestId('request-form-submit')).toBeVisible());
        await visit('/?dashboard=1', 'Dashboard', () => expect(page.getByTestId('open-count')).toBeVisible());

        // ---- Reconnecting: syncs aborted while the phone is online (two quick Refresh now taps make the two
        // failures the store waits for): the amber banner, the badge and the line's clock time
        await visit('/?view=pending', 'Pending (before reconnecting)', () => expect(row(waiting.id)).toBeVisible({ timeout: 15_000 }));
        await page.route('**/api/sync*', (route) => route.abort());
        try {
          const refresh = page.getByRole('button', { name: 'Refresh now', exact: true });
          for (let i = 0; i < 4 && (await page.getByTestId('connection-banner').count()) === 0; i += 1) {
            await refresh.click();
            await expect(refresh).not.toHaveAttribute('data-refreshing', { timeout: 15_000 });
          }
          await expect(page.getByTestId('connection-banner')).toHaveText('Reconnecting…', { timeout: 30_000 });
          await expect(page.getByTestId('live-text')).toHaveText(/^Last updated /);
          results.push(await audit(page, 'Pending reconnecting'));
        } finally {
          await page.unroute('**/api/sync*');
        }

        // ---- Offline: the banner, and answers that need a connection
        await visit('/?view=pending', 'Pending (before offline)', () => expect(row(waiting.id)).toBeVisible({ timeout: 15_000 }));
        await context.setOffline(true);
        try {
          await expect(page.getByTestId('connection-indicator')).toHaveAttribute('data-state', 'offline', { timeout: 15_000 });
          results.push(await audit(page, 'Pending offline'));
        } finally {
          await context.setOffline(false);
        }

        // ---- Offline forms: "Offline · N waiting to send" on New request, "Needs a connection" on Edit
        await page.goto('/?new=1');
        await expect(page.getByTestId('request-form-submit')).toBeVisible();
        await context.setOffline(true);
        try {
          await expect(page.getByRole('status').filter({ hasText: /^Offline · \d+ waiting to send$/ })).toBeVisible({ timeout: 15_000 });
          results.push(await audit(page, 'New request offline'));
        } finally {
          await context.setOffline(false);
        }
        await page.goto(`/?r=${waiting.id}&edit=all`);
        await expect(page.getByTestId('request-form-submit')).toBeVisible();
        await context.setOffline(true);
        try {
          await expect(page.getByRole('status').filter({ hasText: 'Needs a connection' })).toBeVisible({ timeout: 15_000 });
          results.push(await audit(page, 'Edit offline'));
        } finally {
          await context.setOffline(false);
        }

        for (const r of results) expect.soft(r, r.view).toEqual(clean(r));
      });
    });
  });
}
