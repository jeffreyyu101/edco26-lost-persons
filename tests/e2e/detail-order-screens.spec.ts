import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser } from '@playwright/test';
import type { RequestDetail, RequestSummary } from '../../lib/api-types';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { newSignedInContext } from './helpers/session';

// Screenshots of the request page in its new order (Request page order R1, Brian 2026-11-07): header → status
// block → the latest-message line → Details → Photos → Messages → Audit trail. Three requests as front of house
// sees them: waiting with Needs info (medical asked), Located with an unread message, and a plain one (no
// line). Writes design/screens/detail-order-<state>-<w>x<h>-<theme>.png at 390 × 844 and 1440 × 900, light and
// dark. Only with LP_DETAIL_ORDER_SCREENS=1 (Chromium); never part of the gate. Synthetic rows, closed again.

const BASE = testBaseUrl();
const FOH = { staffName: 'Dana Kent', team: 'GC/HX - Special Operations/Med Transpo' };
const MED = { staffName: 'Rae Chen', team: 'Medical' };
const OUT = 'design/screens';

test.skip(!process.env.LP_DETAIL_ORDER_SCREENS, 'screenshots only with LP_DETAIL_ORDER_SCREENS=1');
test.use({ serviceWorkers: 'block' });

async function call<T>(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

const created: string[] = [];

async function make(request: APIRequestContext, fields: Record<string, string>): Promise<RequestSummary> {
  const { request: row } = await call<{ request: RequestSummary }>(request, 'POST', '/api/requests', {
    clientMutationId: randomUUID(),
    reportingLocation: 'FA 4 – Oasis',
    ...fields,
  });
  created.push(row.id);
  return row;
}

const say = (request: APIRequestContext, id: string, body: string) => call(request, 'POST', `/api/requests/${id}/messages`, { clientMutationId: randomUUID(), body });

async function status(request: APIRequestContext, id: string, to: string, kind: string) {
  const row = await call<RequestDetail>(request, 'GET', `/api/requests/${id}`);
  return call<{ request: RequestSummary }>(request, 'POST', `/api/requests/${id}/status`, { status: to, expectedVersion: row.rowVersion, kind });
}

async function themed(browser: Browser, width: number, height: number, theme: 'light' | 'dark') {
  const phone = width < 768;
  const ctx = await newSignedInContext(browser, FOH, { viewport: { width, height }, isMobile: phone, hasTouch: phone, deviceScaleFactor: 2 });
  await ctx.addInitScript((t) => {
    try {
      window.localStorage.setItem('lp-theme', t);
    } catch {
      // ignore
    }
  }, theme);
  return ctx;
}

/** Closes a request (cancel while waiting, Reunited while In medical); best effort. */
async function close(request: APIRequestContext, id: string): Promise<void> {
  try {
    const row = await call<RequestDetail>(request, 'GET', `/api/requests/${id}`);
    if (row.status === 'Added') await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: BASE } });
    else if (row.status === 'Found – Awaiting Reunion')
      await request.fetch(`/api/requests/${id}/status`, { method: 'POST', data: { status: 'Reunited – Closed', expectedVersion: row.rowVersion, kind: 'reunite' }, headers: { Origin: BASE } });
  } catch {
    // Best effort.
  }
}

test.afterAll(async ({ browser }) => {
  const ctx = await newSignedInContext(browser, FOH);
  for (const id of created.splice(0)) await close(ctx.request, id);
  await ctx.close();
});

test('request page order screens', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium only');
  test.setTimeout(300_000);
  const fohCtx = await newSignedInContext(browser, FOH);
  const medCtx = await newSignedInContext(browser, MED);
  const foh = fohCtx.request;
  const med = medCtx.request;

  const person = (name: string, age: string, gender: string, clothing: string, lastSeen: string) => ({
    name,
    age,
    gender,
    clothing,
    lastSeen,
    hair: 'Long, blue braids',
    contactName: 'Maya R.',
    contactRelationship: 'Friend',
    contactPhone: '407-555-0142',
  });
  // Opening a request reads its thread, so each screenshot gets its own request, unread when it opens.
  const STATES = {
    'needs-info': async () => {
      const r = await make(foh, person('Jordan Diaz', 'mid-20s', 'Male', 'Red hoodie, black joggers', 'Kinetic Field, left rail'));
      await say(med, r.id, 'Any tattoos or marks?');
      return r.id;
    },
    'in-medical-unread': async () => {
      const r = await make(foh, person('Ava Lin', '21', 'Female', 'Silver jacket, pink hair', 'Circuit Grounds bridge'));
      const answered = await status(med, r.id, 'Found – Awaiting Reunion', 'answer');
      await call(med, 'PATCH', `/api/requests/${r.id}`, { patch: { medicalLocation: 'Chair 14' }, expectedVersion: answered.request.rowVersion });
      await say(med, r.id, 'Awake and talking. Bring 1 person only');
      return r.id;
    },
    plain: async () => (await make(foh, person('Eli Novak', '23', 'Male', 'Neon green bucket hat, mesh top', 'Main stage, front left'))).id,
  } as const;

  const SIZES = [
    [390, 844],
    [1440, 900],
  ] as const;
  try {
    for (const theme of ['light', 'dark'] as const) {
      for (const [w, h] of SIZES) {
        for (const [state, setup] of Object.entries(STATES)) {
          const id = await setup();
          const ctx = await themed(browser, w, h, theme);
          const page = await ctx.newPage();
          await page.goto(`/?r=${id}`);
          await expect(page.getByTestId('messages')).toBeVisible({ timeout: 20_000 });
          await expect(page.getByTestId('thread-preview')).toHaveCount(state === 'plain' ? 0 : 1, { timeout: 20_000 });
          await page.waitForTimeout(1_500);
          await page.screenshot({ path: `${OUT}/detail-order-${state}-${w}x${h}-${theme}.png` });
          await ctx.close();
          // Closed at once, so the desk's list behind the next one holds no copies of it.
          await close(foh, id);
        }
      }
    }
  } finally {
    await fohCtx.close();
    await medCtx.close();
  }
});
