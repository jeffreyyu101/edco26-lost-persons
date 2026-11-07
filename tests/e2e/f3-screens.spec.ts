import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser } from '@playwright/test';
import type { RequestDetail, RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { newSignedInContext } from './helpers/session';

// Screenshots of the F3 screens for the side-by-side check against the approved renders
// (design/screens/updates-v7-*.png, enroute-edit-*.png, clarify-*.png, f34-v2-5/6.png). Writes
// design/screens/f3-*.png at 390 × 844 and 1440 × 900, light and dark. Only with LP_F3_SCREENS=1 (Chromium);
// never part of the gate. Synthetic rows, closed again afterwards.

const BASE = testBaseUrl();
const RUN = Date.now().toString(36).slice(-4);
const FOH = { staffName: `Dana Kent ${RUN}`, team: 'GC/HX - Special Operations/Med Transpo' };
const MED = { staffName: 'Rae Chen', team: 'Medical' };
const OUT = 'design/screens';

test.skip(!process.env.LP_F3_SCREENS, 'screenshots only with LP_F3_SCREENS=1');
test.use({ serviceWorkers: 'block' });

async function call<T>(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function make(request: APIRequestContext, name: string, age: string, gender: string, clothing: string): Promise<RequestSummary> {
  const { request: row } = await call<{ request: RequestSummary }>(request, 'POST', '/api/requests', {
    clientMutationId: randomUUID(),
    reportingLocation: 'FA 4 – Oasis',
    name,
    age,
    gender,
    clothing,
  });
  created.push({ id: row.id, request });
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

test.afterAll(async () => {
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

test('F3 screens', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium only');
  test.setTimeout(300_000);
  const fohCtx = await newSignedInContext(browser, FOH);
  const medCtx = await newSignedInContext(browser, MED);
  const foh = fohCtx.request;
  const med = medCtx.request;

  // My requests: J.D. needs info (medical asked), E.N. waiting, A.L. in medical with me en route.
  const al = await make(foh, 'A. L.', '21', 'Female', 'Silver jacket, pink hair');
  await make(foh, 'E. N.', '23', '', 'Neon green bucket hat, mesh top');
  const jd = await make(foh, 'J. D.', 'mid-20s', 'Male', 'Red hoodie, black joggers');
  await say(med, jd.id, 'Any tattoos or marks?');
  const inMed = await status(med, al.id, 'Found – Awaiting Reunion', 'answer');
  await call(med, 'PATCH', `/api/requests/${al.id}`, { patch: { medicalLocation: 'Chair 14' }, expectedVersion: inMed.request.rowVersion });
  await say(med, al.id, 'Being worked up');
  await say(med, al.id, 'Bring 1 person only');
  await say(foh, al.id, 'Got it, just me and the friend');
  await call(med, 'POST', `/api/requests/${al.id}/messages/read`, {});
  await call(foh, 'POST', `/api/requests/${al.id}/enroute`, { action: 'set', etaMinutes: 5 });
  await say(med, al.id, 'Ready for them');
  await fohCtx.close();
  await medCtx.close();

  const SIZES = [
    [390, 844],
    [1440, 900],
  ] as const;
  // My requests first, while the messages are still unread (the badges and dots show).
  for (const theme of ['light', 'dark'] as const) {
    for (const [w, h] of SIZES) {
      const ctx = await themed(browser, FOH, w, h, theme);
      const page = await ctx.newPage();
      await page.goto('/?view=mine');
      await expect(page.locator(`[data-request-id="${al.id}"]`).first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: `${OUT}/f3-mine-${w}x${h}-${theme}.png` });
      await ctx.close();
    }
  }

  for (const theme of ['light', 'dark'] as const) {
    for (const [w, h] of SIZES) {
      const size = `${w}x${h}-${theme}`;
      // Front of house: the thread and the en route sheet (edit).
      const ctx = await themed(browser, FOH, w, h, theme);
      const page = await ctx.newPage();
      await page.goto(`/?r=${al.id}`);
      await expect(page.getByTestId('location-row')).toContainText('Chair 14', { timeout: 20_000 });
      await expect(page.getByTestId('messages').getByTestId('bubble-mine')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(1_000);
      await page.getByTestId('messages').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${OUT}/f3-thread-${size}.png` });

      // En route sheet (edit: my ETA selected) from the row in the status block.
      await page.getByTestId('status-block').getByTestId('enroute-row').click();
      await expect(page.getByTestId('enroute-sheet')).toBeVisible();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/f3-enroute-edit-${size}.png` });
      await page.keyboard.press('Escape');
      await ctx.close();
    }
  }

  // The "new" sheet and medical's To check card need their own requests.
  const ctx0 = await newSignedInContext(browser, FOH);
  const rp = await make(ctx0.request, 'R. P.', '30', 'Male', 'White tee, cargo shorts');
  await ctx0.close();
  const medCtx2 = await newSignedInContext(browser, MED);
  await status(medCtx2.request, rp.id, 'Found – Awaiting Reunion', 'answer');
  await medCtx2.close();
  for (const theme of ['light', 'dark'] as const) {
    for (const [w, h] of SIZES) {
      const size = `${w}x${h}-${theme}`;
      const ctx = await themed(browser, FOH, w, h, theme);
      const page = await ctx.newPage();
      await page.goto(`/?r=${rp.id}`);
      await expect(page.getByTestId('messages')).toBeVisible({ timeout: 20_000 });
      await page.getByTestId('messages').getByRole('button', { name: /^En route/ }).click();
      await expect(page.getByTestId('enroute-sheet')).toBeVisible();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/f3-enroute-new-${size}.png` });
      await ctx.close();

      // Medical: Pending → To check, J.D.'s card with Message left of the answers and the preview.
      const mctx = await themed(browser, MED, w, h, theme);
      const mp = await mctx.newPage();
      await mp.goto('/?view=pending');
      const card = mp.locator(`[data-testid="check-card"]:has([data-request-id="${jd.id}"])`);
      await expect(card).toBeVisible({ timeout: 20_000 });
      await card.scrollIntoViewIfNeeded();
      await mp.waitForTimeout(800);
      await mp.screenshot({ path: `${OUT}/f3-pending-${size}.png` });
      await mctx.close();
    }
  }
});
