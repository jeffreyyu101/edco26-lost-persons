import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ChangeResponse, CreateResponse, RequestDetail, RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { axeContrastUnder, axeViolations, overlappingTargets, smallTargets, type AxeFinding } from './helpers/a11y';
import { syntheticPng } from './helpers/png';
import { signedInAs } from './helpers/session';

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

/**
 * Text on the brand row (components/list/BrandCard.tsx) lies on a gradient with two glows, which axe can only
 * mark "needs review". So this measures it: the row is captured with its text made transparent, and each run
 * of text is compared with every pixel behind its line box. Returns one line per run under 4.5:1 (the bar for
 * small text, applied to the title too).
 */
async function brandContrast(page: Page): Promise<string[]> {
  const card = page.getByTestId('brand-card');
  const layout = await card.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const runs: Array<{ text: string; color: string; x: number; y: number; w: number; h: number }> = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? '').trim();
      if (!text) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const color = getComputedStyle(n.parentElement!).color;
      for (const r of Array.from(range.getClientRects())) runs.push({ text, color, x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height });
    }
    return { width: box.width, runs };
  });
  // "Is my friend", "in medical?" and the dates (the long dates on a wide screen instead of the short ones).
  expect(layout.runs.length).toBeGreaterThanOrEqual(3);
  const hide = await page.addStyleTag({ content: '[data-testid="brand-card"] * { color: transparent !important; }' });
  const png = await card.screenshot({ animations: 'disabled' });
  await hide.evaluate((el) => (el as Element).remove());
  return page.evaluate(
    async ({ data, width, runs }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const scale = img.width / width;
      const channel = (v: number) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (r: number, g: number, b: number) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      const out: string[] = [];
      for (const run of runs) {
        const [r, g, b] = (run.color.match(/[\d.]+/g) ?? []).map(Number) as [number, number, number];
        const text = luminance(r, g, b);
        const x0 = Math.max(0, Math.floor(run.x * scale));
        const y0 = Math.max(0, Math.floor(run.y * scale));
        const x1 = Math.min(img.width, Math.ceil((run.x + run.w) * scale));
        const y1 = Math.min(img.height, Math.ceil((run.y + run.h) * scale));
        const px = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
        let worst = Infinity;
        for (let i = 0; i < px.length; i += 4) {
          const back = luminance(px[i]!, px[i + 1]!, px[i + 2]!);
          worst = Math.min(worst, (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05));
        }
        if (worst < 4.5) out.push(`"${run.text}" ${run.color}: ${worst.toFixed(2)}:1`);
      }
      return out;
    },
    { data: png.toString('base64'), width: layout.width, runs: layout.runs },
  );
}

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

      test(`signed-in views pass axe and have 44 px targets (${theme})`, async ({ context, page }) => {
        test.slow();
        const waiting = await createRequest(page);
        const answerMe = await createRequest(page);
        const coming = await setStatus(page, await createRequest(page), 'Found – Awaiting Reunion', 'answer');
        await setStatus(page, await createRequest(page), 'Checked – Not Found', 'answer');
        await setStatus(page, await setStatus(page, await createRequest(page), 'Found – Awaiting Reunion', 'answer'), 'Reunited – Closed', 'reunite');
        const other = await createRequest(page, { reportingLocation: 'Other', otherLocation: 'Base' });
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
        await page.setViewportSize({ width: 1280, height: 800 });
        expect.soft(await brandContrast(page), `brand row, 1280 px (${theme})`).toEqual([]);
        await page.setViewportSize({ width: 390, height: 664 });

        // Log option B: the closed requests open in place under "Archived N", greyed (contrast, spec §7).
        await page.getByTestId('closed-fold').click();
        await expect(page.getByTestId('closed-rows')).toBeVisible();
        results.push(await audit(page, 'All, Archived open'));
        await page.getByTestId('closed-fold').click();

        await page.getByTestId('account-trigger').click();
        await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
        results.push(await audit(page, 'account menu'));

        // The Alerts switch in the avatar menu (it replaced the header bell).
        await page.getByRole('dialog', { name: 'Account' }).getByRole('switch', { name: 'Alerts' }).click();
        const bell = page.getByRole('dialog', { name: 'Alerts are on' });
        await expect(bell).toBeVisible();
        // Named and described by the visible heading and line, each in the sheet once (no hidden copy that
        // a screen reader would read twice).
        await expect(bell).toHaveAccessibleDescription('New requests alert you while this app is open.');
        await expect(bell.getByText('Alerts are on', { exact: true })).toHaveCount(1);
        await expect(bell.getByText('New requests alert you while this app is open.', { exact: true })).toHaveCount(1);
        await expect(bell.getByRole('heading', { name: 'Alerts are on' })).toBeVisible();
        results.push(await audit(page, 'bell sheet'));
        await page.getByRole('button', { name: 'Got it' }).click();

        await visit('/?view=pending', 'Pending', () => expect(row(waiting.id)).toBeVisible({ timeout: 15_000 }));
        await page.locator(`[data-testid="check-card"]:has([data-request-id="${answerMe.id}"])`).getByRole('button', { name: 'Not in medical' }).click();
        await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
        results.push(await audit(page, 'Pending + Undo snackbar'));

        await visit('/?view=mine', 'My requests', () => expect(row(coming.id)).toBeVisible({ timeout: 15_000 }));
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
        await visit(`/?r=${coming.id}`, 'Profile (in medical)', () => expect(page.getByTestId('audit-item').first()).toBeVisible());
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
