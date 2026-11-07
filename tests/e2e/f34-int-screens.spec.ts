import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser } from '@playwright/test';
import type { RequestDetail, RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { newSignedInContext } from './helpers/session';

// Screenshots of the F3 + F4 release's key screens on top of production's (F2, F5, Pending v9.1): Pending
// (medical), the request with its thread and en route row (front of house), My requests and Activity (front of
// house). Writes design/screens/f34-int-*.png at 390 × 844 and 1440 × 900, light and dark. Only with
// LP_F34_SCREENS=1 (Chromium), on a freshly seeded stack; never part of the gate. Synthetic rows, closed again
// afterwards.

const BASE = testBaseUrl();
const FOH = { staffName: 'Dana Kent', team: 'GC/HX - Special Operations/Med Transpo' };
const MED = { staffName: 'Rae Chen', team: 'Medical' };
const OUT = 'design/screens';

test.skip(!process.env.LP_F34_SCREENS, 'screenshots only with LP_F34_SCREENS=1');
test.use({ serviceWorkers: 'block' });

async function call<T>(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

const created: Array<{ id: string }> = [];

async function make(request: APIRequestContext, name: string, age: string, gender: string, clothing: string): Promise<RequestSummary> {
  const { request: row } = await call<{ request: RequestSummary }>(request, 'POST', '/api/requests', {
    clientMutationId: randomUUID(),
    reportingLocation: 'FA 4 – Oasis',
    name,
    age,
    gender,
    clothing,
  });
  created.push({ id: row.id });
  return row;
}

const say = (request: APIRequestContext, id: string, body: string) => call(request, 'POST', `/api/requests/${id}/messages`, { clientMutationId: randomUUID(), body });

async function status(request: APIRequestContext, id: string, to: string, kind: string) {
  const row = await call<RequestDetail>(request, 'GET', `/api/requests/${id}`);
  return call<{ request: RequestSummary }>(request, 'POST', `/api/requests/${id}/status`, { status: to, expectedVersion: row.rowVersion, kind });
}

async function themed(browser: Browser, who: typeof FOH, width: number, height: number, theme: 'light' | 'dark') {
  const phone = width < 768;
  const ctx = await newSignedInContext(browser, who, { viewport: { width, height }, isMobile: phone, hasTouch: phone, deviceScaleFactor: 2 });
  await ctx.addInitScript((t) => {
    try {
      window.localStorage.setItem('lp-theme', t);
    } catch {
      // ignore
    }
  }, theme);
  return ctx;
}

test.afterAll(async ({ browser }) => {
  const ctx = await newSignedInContext(browser, FOH);
  const request = ctx.request;
  for (const { id } of created.splice(0)) {
    try {
      const row = await call<RequestDetail>(request, 'GET', `/api/requests/${id}`);
      if (row.status === 'Added') await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: BASE } });
      else if (row.status === 'Found – Awaiting Reunion')
        await request.fetch(`/api/requests/${id}/status`, { method: 'POST', data: { status: 'Reunited – Closed', expectedVersion: row.rowVersion, kind: 'reunite' }, headers: { Origin: BASE } });
    } catch {
      // Best effort.
    }
  }
  await ctx.close();
});

test('F3 + F4 release screens', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium only');
  test.setTimeout(420_000);
  const fohCtx = await newSignedInContext(browser, FOH);
  const medCtx = await newSignedInContext(browser, MED);
  const foh = fohCtx.request;
  const med = medCtx.request;

  // Waiting for check: J.D. (medical asked: Needs info), K.T. (the first Not found: the "Not found yet" hold).
  // Friend coming: A.L. at Chair 14 with Dana en route, R.P. just answered.
  const kt = await make(foh, 'K. T.', '19', 'Female', 'Yellow raincoat, glitter boots');
  const al = await make(foh, 'A. L.', '21', 'Female', 'Silver jacket, pink hair');
  const rp = await make(foh, 'R. P.', '30', 'Male', 'White tee, cargo shorts');
  const jd = await make(foh, 'J. D.', 'mid-20s', 'Male', 'Red hoodie, black joggers');
  await status(med, kt.id, 'Checked – Not Found', 'answer');
  const inMed = await status(med, al.id, 'Found – Awaiting Reunion', 'answer');
  await call(med, 'PATCH', `/api/requests/${al.id}`, { patch: { medicalLocation: 'Chair 14' }, expectedVersion: inMed.request.rowVersion });
  await say(med, al.id, 'Bring 1 person only');
  await say(foh, al.id, 'Got it, on my way with them');
  await call(med, 'POST', `/api/requests/${al.id}/messages/read`, {});
  await call(foh, 'POST', `/api/requests/${al.id}/enroute`, { action: 'set', etaMinutes: 5 });
  await say(med, al.id, 'Ready for them');
  await status(med, rp.id, 'Found – Awaiting Reunion', 'answer');
  await say(med, jd.id, 'Any tattoos or marks?');
  await fohCtx.close();
  await medCtx.close();
  // Let the notifications (after the responses) write their Activity rows.
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  const SIZES = [
    [390, 844],
    [1440, 900],
  ] as const;

  for (const theme of ['light', 'dark'] as const) {
    for (const [w, h] of SIZES) {
      const size = `${w}x${h}-${theme}`;

      // Front of house: Activity first (everything unread), then My requests.
      const ctx = await themed(browser, FOH, w, h, theme);
      const page = await ctx.newPage();
      await page.goto('/?view=mine');
      await expect(page.locator(`[data-request-id="${al.id}"]`).first()).toBeVisible({ timeout: 20_000 });
      const bell = page.getByTestId('activity-bell').filter({ visible: true }).first();
      await expect(bell).toHaveAttribute('data-unread', /[1-9]/, { timeout: 20_000 });
      await bell.click();
      const panel = page.locator('[data-testid="activity-sheet"], [data-testid="activity-popover"]').filter({ visible: true }).first();
      await expect(panel).toBeVisible();
      await page.waitForTimeout(1_000);
      await page.screenshot({ path: `${OUT}/f34-int-activity-${size}.png` });
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${OUT}/f34-int-mine-${size}.png` });

      // The request: F5's status block with F3's en route row in its slot, then the thread.
      await page.goto(`/?r=${al.id}`);
      await expect(page.getByTestId('location-row').filter({ visible: true }).first()).toContainText('Chair 14', { timeout: 20_000 });
      await expect(page.getByTestId('messages').filter({ visible: true }).first().getByTestId('bubble-mine')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(1_000);
      await page.screenshot({ path: `${OUT}/f34-int-request-${size}.png` });
      await ctx.close();

      // Medical: Pending (v9.1) with F3's preview row, Message button, en route row and the unread dot.
      const mctx = await themed(browser, MED, w, h, theme);
      const mp = await mctx.newPage();
      await mp.goto('/?view=pending');
      await expect(mp.locator(`[data-testid="check-card"]:has([data-request-id="${kt.id}"])`)).toBeVisible({ timeout: 20_000 });
      await expect(mp.locator(`[data-testid="friend-coming-card"]:has([data-request-id="${al.id}"])`).getByTestId('enroute-row')).toBeVisible({ timeout: 20_000 });
      await mp.waitForTimeout(1_000);
      await mp.screenshot({ path: `${OUT}/f34-int-pending-${size}.png` });
      await mctx.close();
    }
  }
});
