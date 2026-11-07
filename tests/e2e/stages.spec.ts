import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { AuditEvent, RequestDetail, RequestSummary } from '../../lib/api-types';
import { STATUS, STATUS_META, actionLabel } from '../../lib/domain';
import { formatClockAmPm } from '../../lib/format';
import { ROOT, testBaseUrl } from '../../scripts/test-env.mjs';
import { axeViolations, smallTargets } from './helpers/a11y';
import { newSignedInContext, signedInAs, type TestStaff } from './helpers/session';

// F5: status stages and the "Not found yet" hold (design/screens/updates.html #clarify / #recheck / #colors),
// end to end:
//   * the real flow on the real store, API and database: medical answers Not found → the card moves to Later
//     (Undo puts it back) → the page clock passes the recheck time → the card is back on top as a Recheck →
//     the second Not found closes it; front of house's My requests card shows Not found yet + Recheck, then
//     the final grey Not in medical; the desk status cell's strings;
//   * a fixture (page.route on /api/sync and the request) for every stage at once: overflow at 375, 390, 820,
//     1180 and 1440 px (nothing wider than its container, nothing outside the viewport, one-line status tags),
//     the post-rename long label "Not found in medical · 2 checks", axe in light and dark, and the screenshots
//     (LP_F5_SHOTS=1 writes design/screens/f5-*.png).
// Synthetic rows only (TEST-F5-…), closed again afterwards.

const BASE = testBaseUrl();
const TZ = 'America/New_York';
const MEDIC: TestStaff = { staffName: 'TEST-F5 Medic', team: 'Medical' };
const FOH: TestStaff = { staffName: 'TEST-F5 Front', team: 'GC/HX - Dispatch' };
const TAG = `TEST-F5-${Date.now().toString(36)}`;
const NOT_FOUND = actionLabel('notInMedical');
const NOT_IN_MEDICAL = STATUS_META[STATUS.notInMedical].shortLabel;
let seq = 0;

test.use({ serviceWorkers: 'block' });
signedInAs(MEDIC);

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function call<T>(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, {
    method,
    data,
    headers: { Origin: BASE },
  });
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function createRequest(request: APIRequestContext, extra: Record<string, unknown> = {}): Promise<RequestSummary> {
  seq += 1;
  const body = {
    clientMutationId: randomUUID(),
    reportingLocation: 'FA 4 – Oasis',
    name: `${TAG} P${seq}`,
    age: '19',
    gender: 'Female',
    clothing: `Synthetic ${TAG} tutu ${seq}`,
    ...extra,
  };
  const { request: row } = await call<{ request: RequestSummary }>(request, 'POST', '/api/requests', body);
  created.push({ id: row.id, request });
  return row;
}

const setStatus = async (request: APIRequestContext, r: RequestSummary, status: string, kind = 'answer') =>
  (await call<{ request: RequestSummary }>(request, 'POST', `/api/requests/${r.id}/status`, { status, expectedVersion: r.rowVersion, kind })).request;

test.afterEach(async () => {
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await call<RequestDetail>(request, 'GET', `/api/requests/${id}`);
      if (row.status === 'Added')
        await request.fetch(`/api/requests/${id}/cancel`, {
          method: 'POST',
          data: { expectedVersion: row.rowVersion },
          headers: { Origin: BASE },
        });
      else if (row.status === 'Found – Awaiting Reunion')
        await request.fetch(`/api/requests/${id}/status`, {
          method: 'POST',
          data: {
            status: 'Reunited – Closed',
            expectedVersion: row.rowVersion,
            kind: 'reunite',
          },
          headers: { Origin: BASE },
        });
    } catch {
      // Best effort.
    }
  }
});

const checkCard = (page: Page, id: string) => page.locator(`[data-testid="check-card"]:has([data-request-id="${id}"])`);
const laterRow = (page: Page, id: string) => page.locator(`[data-testid="later-row"][data-request-id="${id}"]`);
const mineCard = (page: Page, id: string) => page.locator(`[data-testid="mine-card"]:has([data-request-id="${id}"])`);

async function phoneContext(browser: Browser, staff: TestStaff): Promise<BrowserContext> {
  return newSignedInContext(browser, staff, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    serviceWorkers: 'block',
  });
}

// ---------------------------------------------------------------------------------------------------
// The real flow
// ---------------------------------------------------------------------------------------------------

test('medical: Not found → Later (Undo puts it back) → due on top → the second Not found closes it; front of house sees each step', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await page.clock.install();
  const fohContext = await phoneContext(browser, FOH);
  const foh = await fohContext.newPage();
  try {
    const r = await createRequest(foh.request);
    await page.goto('/?view=pending');
    await expect(checkCard(page, r.id)).toBeVisible({ timeout: 20_000 });
    await expect(
      checkCard(page, r.id).getByRole('button', {
        name: NOT_FOUND,
        exact: true,
      }),
    ).toBeVisible();

    // First Not found: the card leaves the queue for Later, with "Not found · recheck 4:40" and Undo.
    await checkCard(page, r.id).getByRole('button', { name: NOT_FOUND, exact: true }).click();
    await expect(checkCard(page, r.id)).toHaveCount(0);
    await expect(laterRow(page, r.id)).toBeVisible();
    await expect(
      page.getByRole('status').filter({
        hasText: new RegExp(`^${NOT_FOUND} · recheck \\d{1,2}:\\d\\d`),
      }),
    ).toBeVisible();

    // Undo: back in the queue, the hold gone.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(checkCard(page, r.id)).toBeVisible();
    await expect(laterRow(page, r.id)).toHaveCount(0);
    await expect.poll(async () => (await call<RequestDetail>(page.request, 'GET', `/api/requests/${r.id}`)).notFoundChecks).toBe(0);

    // Again, for real this time.
    await checkCard(page, r.id).getByRole('button', { name: NOT_FOUND, exact: true }).click();
    await expect(laterRow(page, r.id)).toBeVisible();
    const held = await call<RequestDetail>(page.request, 'GET', `/api/requests/${r.id}`);
    expect(held).toMatchObject({ status: STATUS.waiting, notFoundChecks: 1 });
    const recheck = formatClockAmPm(held.recheckAt as string, TZ);
    await expect(laterRow(page, r.id)).toContainText(recheck);

    // Front of house: still open, the violet chip and the recheck time.
    await foh.goto('/?view=mine');
    const card = mineCard(foh, r.id);
    await expect(card.getByTestId('stage-chip')).toHaveText('Not found yet', {
      timeout: 20_000,
    });
    await expect(card.getByTestId('recheck-time-chip')).toHaveText(`Recheck ${recheck}`);

    // 21 minutes later on medical's phone: due, and back on top as a Recheck.
    await page.clock.fastForward('21:00');
    await expect(laterRow(page, r.id)).toHaveCount(0);
    const due = checkCard(page, r.id);
    await expect(due).toHaveAttribute('data-recheck', '');
    await expect(due.getByTestId('recheck-chip')).toHaveText('Recheck');
    await expect(page.locator('[data-testid="check-card"]').first()).toHaveAttribute('data-pending-card', r.id);
    // Never closed by itself.
    expect((await call<RequestDetail>(page.request, 'GET', `/api/requests/${r.id}`)).status).toBe(STATUS.waiting);

    // The second Not found is final.
    await due.getByRole('button', { name: NOT_FOUND, exact: true }).click();
    await expect(checkCard(page, r.id)).toHaveCount(0);
    await expect(laterRow(page, r.id)).toHaveCount(0);
    await expect.poll(async () => (await call<RequestDetail>(page.request, 'GET', `/api/requests/${r.id}`)).status).toBe(STATUS.notInMedical);

    // Front of house: the final grey answer, with no chip.
    await expect(mineCard(foh, r.id).getByTestId('stage-chip')).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(mineCard(foh, r.id)).toContainText(NOT_IN_MEDICAL);
    await expect(foh.locator('[data-testid="mine-closed"]').locator(`[data-request-id="${r.id}"]`)).toHaveCount(1);
  } finally {
    await fohContext.close();
  }
});

test('the request (medical): Not found yet in violet, who answered, Recheck, and the answers inside the block', async ({ page }) => {
  const r = await createRequest(page.request);
  const held = await setStatus(page.request, r, STATUS.notInMedical);
  await page.goto(`/?r=${r.id}`);
  const block = page.getByTestId('status-block');
  await expect(block).toHaveAttribute('data-tone', 'violet', {
    timeout: 20_000,
  });
  await expect(block.getByTestId('status-label')).toHaveText('Not found yet');
  await expect(block).toContainText(MEDIC.staffName);
  await expect(block.getByTestId('recheck-row')).toHaveText(`Recheck ${formatClockAmPm(held.recheckAt as string, TZ)}`);
  const answers = block.getByTestId('block-answers');
  await expect(answers.getByRole('button', { name: NOT_FOUND, exact: true })).toBeVisible();
  await expect(
    answers.getByRole('button', {
      name: actionLabel('inMedical'),
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByTestId('profile-actions')).toHaveCount(0);
  // The audit trail: Waiting for check → Not found yet, with the recheck time.
  await expect(page.getByTestId('audit-item').first()).toContainText('Not found yet');
  await expect(page.getByTestId('audit-item').first()).toContainText(`Recheck ${formatClockAmPm(held.recheckAt as string, TZ)}`);
  // In medical from the block clears the hold.
  await answers.getByRole('button', { name: actionLabel('inMedical'), exact: true }).click();
  await expect(block).toHaveAttribute('data-tone', 'green');
  await expect(block.getByTestId('recheck-row')).toHaveCount(0);
});

test.describe('desk', () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
  });

  test('the status cell: "Waiting for check · 9m", "Not found yet · 4:40 PM", "In medical · Bed 3", "Not found in medical · 2 checks"; no en route column', async ({
    page,
  }) => {
    const waiting = await createRequest(page.request);
    const held = await setStatus(page.request, await createRequest(page.request), STATUS.notInMedical);
    let located = await setStatus(page.request, await createRequest(page.request), STATUS.inMedical);
    located = (
      await call<{ request: RequestSummary }>(page.request, 'PATCH', `/api/requests/${located.id}`, {
        patch: { medicalLocation: 'Bed 3' },
        expectedVersion: located.rowVersion,
      })
    ).request;
    const first = await setStatus(page.request, await createRequest(page.request), STATUS.notInMedical);
    const final = await setStatus(page.request, first, STATUS.notInMedical);
    expect(final).toMatchObject({
      status: STATUS.notInMedical,
      notFoundChecks: 2,
    });

    await page.goto('/');
    const cell = (id: string) => page.locator(`[data-desk-table] [data-request-id="${id}"] [data-col="status"]`);
    await expect(cell(waiting.id)).toHaveText(/^Waiting for check· (now|\d+m)$/, { timeout: 20_000 });
    await expect(cell(held.id)).toHaveText(`Not found yet· ${formatClockAmPm(held.recheckAt as string, TZ)}`);
    await expect(cell(located.id)).toHaveText(`${STATUS_META[STATUS.inMedical].shortLabel}· Bed 3`);
    await page.getByTestId('closed-fold').first().click();
    await expect(cell(final.id)).toHaveText(`${NOT_IN_MEDICAL}· 2 checks`);
    // The violet tone, the hourglass; and no separate en route column.
    await expect(cell(held.id)).toHaveAttribute('data-tone', 'violet');
    await expect(cell(held.id).locator('[data-glyph="hourglass"]')).toHaveCount(1);
    await expect(page.getByTestId('desk-table-columns').locator('[data-col]')).toHaveText(['#', 'Friend', 'Status', 'Post', 'Created', 'Updated', 'Logged by']);
    // Nothing in the status cell is cut at 1440.
    for (const id of [waiting.id, held.id, located.id, final.id]) {
      expect(await cell(id).evaluate((el) => [...el.querySelectorAll('span')].every((s) => s.scrollWidth <= s.clientWidth + 1))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// The fixture: every stage at once (synced rows, mocked)
// ---------------------------------------------------------------------------------------------------

// 4:20 PM in New York on the event's first day, as in the mockups.
const T0 = Date.parse('2026-11-06T21:20:00Z');
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const FIX_STAFF = 'Dana Kim · GC/HX - Special Operations/Med Transpo';

function fixtureRow(n: number, name: string, over: Record<string, unknown>): RequestSummary {
  const id = `f5000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    id,
    clientMutationId: null,
    caseNumber: n,
    firstName: name,
    lastName: null,
    age: '19',
    gender: 'Female',
    heightBuild: null,
    hair: null,
    identifyingFeatures: null,
    physicalDescription: null,
    lastSeen: null,
    clothing: 'Pink tutu, silver body glitter',
    additionalNotes: null,
    reportingLocation: 'FA 3 – Kinetic',
    otherLocation: null,
    contactName: 'Chris P.',
    contactPhone: null,
    contactRelationship: 'boyfriend',
    contactNotes: null,
    status: STATUS.waiting,
    createdBy: FIX_STAFF,
    updatedBy: FIX_STAFF,
    createdAt: iso(-20),
    updatedAt: iso(-20),
    foundAt: null,
    reunionStartedAt: null,
    closedAt: null,
    rowVersion: 1,
    firstPhotoId: null,
    photoCount: 0,
    name,
    postShort: 'FA 3',
    medicalLocation: null,
    recheckAt: null,
    notFoundChecks: 0,
    ...over,
  } as RequestSummary;
}

const RAE = 'Rae Chen · Medical';
const FIXTURE: RequestSummary[] = [
  fixtureRow(15, 'E.N.', {
    createdAt: iso(-9),
    clothing: 'Neon green bucket hat, mesh top',
    age: '23',
    gender: null,
  }),
  // F3's fields (contract F): medical asked, front of house's turn.
  fixtureRow(14, 'J.D.', {
    createdAt: iso(-16),
    age: 'mid-20s',
    gender: 'Male',
    needsInfo: true,
    lastMessage: { by: RAE, mine: false, text: 'Any tattoos or marks?' },
    lastMessageAt: iso(0),
    messageCount: 1,
  }),
  fixtureRow(13, 'K.T.', {
    createdAt: iso(-24),
    recheckAt: iso(20),
    notFoundChecks: 1,
    updatedBy: RAE,
    updatedAt: iso(0),
    rowVersion: 2,
  }),
  fixtureRow(16, 'M.R.', {
    createdAt: iso(-40),
    age: '22',
    reportingLocation: 'FA 4 – Oasis',
    postShort: 'FA 4',
    recheckAt: iso(-2),
    notFoundChecks: 1,
    updatedBy: RAE,
    updatedAt: iso(-22),
    rowVersion: 2,
  }),
  fixtureRow(17, 'S.O.', {
    createdAt: iso(-12),
    age: '28',
    gender: 'Male',
    recheckAt: iso(31),
    notFoundChecks: 1,
    updatedBy: RAE,
    updatedAt: iso(11),
    rowVersion: 2,
  }),
  fixtureRow(12, 'P.V.', {
    createdAt: iso(-30),
    age: '30',
    gender: 'Male',
    status: STATUS.inMedical,
    foundAt: iso(-10),
    reunionStartedAt: iso(-10),
    medicalLocation: 'Bed 3',
    updatedBy: RAE,
    updatedAt: iso(-10),
    rowVersion: 3,
  }),
  fixtureRow(11, 'A.L.', {
    createdAt: iso(-35),
    age: '21',
    status: STATUS.inMedical,
    foundAt: iso(-11),
    reunionStartedAt: iso(-11),
    medicalLocation: 'Chair 14',
    enroute: { count: 1, earliestEta: iso(4), state: 'enroute', mine: null },
    updatedBy: RAE,
    updatedAt: iso(-11),
    rowVersion: 3,
  }),
  fixtureRow(10, 'M.P.', {
    createdAt: iso(-50),
    age: '26',
    gender: 'Male',
    status: STATUS.inMedical,
    foundAt: iso(-20),
    reunionStartedAt: iso(-20),
    enroute: { count: 0, earliestEta: null, state: 'arrived', mine: null },
    updatedBy: RAE,
    updatedAt: iso(-20),
    rowVersion: 3,
  }),
  fixtureRow(7, 'B.W.', {
    createdAt: iso(-68),
    age: '23',
    status: STATUS.notInMedical,
    notFoundChecks: 2,
    reportingLocation: 'FA 4 – Oasis',
    postShort: 'FA 4',
    updatedBy: RAE,
    updatedAt: iso(-8),
    rowVersion: 3,
  }),
  fixtureRow(6, 'S.O.', {
    createdAt: iso(-82),
    age: '28',
    gender: 'Male',
    status: STATUS.reunited,
    closedAt: iso(-45),
    updatedAt: iso(-45),
    rowVersion: 4,
  }),
  fixtureRow(4, 'T.N.', {
    createdAt: iso(-100),
    status: STATUS.cancelled,
    closedAt: iso(-90),
    updatedAt: iso(-90),
    rowVersion: 2,
  }),
];
const byId = new Map(FIXTURE.map((r) => [r.id, r]));
const ROW = (n: number) => FIXTURE.find((r) => r.caseNumber === n) as RequestSummary;

function fixtureDetail(row: RequestSummary): RequestDetail {
  const audit: AuditEvent[] = [
    {
      id: `${row.id}-c`,
      at: row.createdAt,
      staff: FIX_STAFF,
      notes: null,
      action: 'created',
      previous: null,
      next: { reportingLocation: row.reportingLocation, otherLocation: null },
    },
  ];
  if (row.recheckAt) {
    audit.push({
      id: `${row.id}-h`,
      at: new Date(Date.parse(row.recheckAt) - 20 * 60_000).toISOString(),
      staff: RAE,
      notes: null,
      action: 'status',
      previous: { status: STATUS.waiting },
      next: {
        status: STATUS.waiting,
        kind: 'answer',
        held: true,
        hold: { recheckAt: row.recheckAt, checks: 1 },
      },
    });
  }
  return { ...row, photos: [], audit };
}

/** Serves the fixture as the synced rows and their details, at the mockups' 4:20 PM. */
async function serveFixture(page: Page, theme: 'light' | 'dark' = 'light') {
  await page.clock.install({ time: T0 });
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('lp-theme', t);
    } catch {}
  }, theme);
  await page.route('**/api/sync**', async (route) => {
    const url = new URL(route.request().url());
    const ids = url.searchParams.get('ids');
    const rows = ids
      ? ids
          .split(',')
          .map((id) => byId.get(id))
          .filter(Boolean)
      : FIXTURE;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        serverTime: new Date(T0).toISOString(),
        rows,
        hasMore: false,
        next: null,
        ...(url.searchParams.get('reconcile') === '1' ? { versions: FIXTURE.map((r) => [r.id, r.rowVersion]) } : {}),
      }),
    });
  });
  await page.route(/\/api\/requests\/f5000000-[^/?]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop() as string;
    const row = byId.get(id);
    await route.fulfill(
      row
        ? {
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(fixtureDetail(row)),
          }
        : { status: 404, body: '{}' },
    );
  });
}

/**
 * Layout problems on the page: an element whose content is cut with no ellipsis (wider than itself, clipped),
 * anything outside the viewport, a status tag on more than one line, or the page scrolling sideways.
 */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${vw}`);
    const label = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}${el.getAttribute('data-col') ? `[col=${el.getAttribute('data-col')}]` : ''} "${(el.textContent ?? '').trim().slice(0, 40)}"`;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && !cs.clipPath.startsWith('inset(50%');
    };
    const roots = [...document.querySelectorAll<HTMLElement>('[data-view], [data-testid="profile"]')];
    const els = roots.flatMap((r) => [...r.querySelectorAll<HTMLElement>('*')]);
    for (const el of els) {
      if (!visible(el) || el.closest('svg')) continue;
      const own = el.getBoundingClientRect();
      // What can be seen of it: clipped by every ancestor that clips. A sideways scroller (chips) may hold
      // content past the viewport on purpose.
      let left = own.left;
      let right = own.right;
      let scroller = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        if (ox === 'auto' || ox === 'scroll') scroller = true;
        if (ox !== 'visible') {
          const ar = a.getBoundingClientRect();
          left = Math.max(left, ar.left);
          right = Math.min(right, ar.right);
        }
      }
      if (right - left <= 0) continue;
      if (!scroller && (right > vw + 1 || left < -1)) out.push(`outside the viewport: ${label(el)} (${Math.round(left)}–${Math.round(right)} of ${vw})`);
      const cs = getComputedStyle(el);
      const clips = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
      // Text cut off with no ellipsis.
      if (clips && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && !el.querySelector('*') && el.textContent?.trim())
        out.push(`cut without an ellipsis: ${label(el)}`);
      // Wider than its container: text that spills out of a box that does not let it scroll.
      const parent = el.parentElement;
      if (parent && !scroller && el.textContent?.trim() && !el.querySelector('*')) {
        const p = parent.getBoundingClientRect();
        if (getComputedStyle(parent).overflowX === 'visible' && (own.right > p.right + 1 || own.left < p.left - 1))
          out.push(`wider than its container: ${label(el)} (${Math.round(own.left)}–${Math.round(own.right)} in ${Math.round(p.left)}–${Math.round(p.right)})`);
      }
    }
    // Status tags are one line.
    for (const el of document.querySelectorAll<HTMLElement>(
      '[data-col="status"], [data-testid="stage-chip"], [data-testid="recheck-chip"], [data-testid="recheck-time-chip"]',
    )) {
      if (!visible(el)) continue;
      const lh = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.4;
      if (el.getBoundingClientRect().height > Math.max(lh * 1.6, 30)) out.push(`status tag wraps: ${label(el)}`);
      if (getComputedStyle(el).whiteSpace !== 'nowrap' && !el.querySelector('[style*="nowrap"]')) {
        const inner = [...el.querySelectorAll<HTMLElement>('span')].every((s) => getComputedStyle(s).whiteSpace === 'nowrap');
        if (!inner) out.push(`status tag may wrap: ${label(el)}`);
      }
    }
    return out;
  });
}

/** Puts the post-rename label (Not found in medical) on every Not in medical status cell, as the rename will. */
async function applyLongLabel(page: Page) {
  await page.evaluate((from) => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-col="status"] span, [data-testid="mine-card"] span')) {
      if (el.children.length === 0 && el.textContent === from) el.textContent = 'Not found in medical';
    }
  }, NOT_IN_MEDICAL);
}

const WIDTHS = [375, 390, 820, 1180, 1440] as const;
const VIEWS = [
  {
    name: 'all',
    path: '/',
    ready: (page: Page) => page.locator(`[data-request-id="${ROW(13).id}"]`).first(),
  },
  {
    name: 'pending',
    path: '/?view=pending',
    ready: (page: Page) => page.getByTestId('later-group').first(),
  },
  {
    name: 'mine',
    path: '/?view=mine',
    // The phone's cards carry the chip; the desk shows My requests as its table.
    ready: (page: Page) => page.locator(`[data-testid="stage-chip"], [data-desk-table] [data-request-id="${ROW(13).id}"]`).first(),
  },
  {
    name: 'request',
    path: `/?r=${ROW(13).id}`,
    ready: (page: Page) => page.getByTestId('recheck-row'),
  },
] as const;

test.describe('fixture', () => {
  // The fixture's rows are logged by Dana Kim: front of house sees them in My requests.
  signedInAs({
    staffName: 'Dana Kim',
    team: 'GC/HX - Special Operations/Med Transpo',
  });

  for (const width of WIDTHS) {
    test(`overflow at ${width} px: every stage, every view, and the long "Not found in medical · 2 checks"`, async ({ browser }) => {
      test.setTimeout(90_000);
      const ctx = await newSignedInContext(
        browser,
        {
          staffName: 'Dana Kim',
          team: 'GC/HX - Special Operations/Med Transpo',
        },
        {
          viewport: {
            width,
            height: width < 768 ? 844 : width < 1024 ? 1180 : 900,
          },
          isMobile: width < 768,
          hasTouch: width < 1280,
          deviceScaleFactor: 1,
          serviceWorkers: 'block',
        },
      );
      const page = await ctx.newPage();
      try {
        await serveFixture(page);
        for (const view of VIEWS) {
          await page.goto(view.path);
          await expect(view.ready(page)).toBeVisible({ timeout: 20_000 });
          if (view.name === 'all') {
            const fold = page.getByTestId('closed-fold').first();
            if ((await fold.getAttribute('aria-expanded')) === 'false') await fold.click();
            await expect(page.locator(`[data-request-id="${ROW(7).id}"]`).first()).toBeVisible();
          }
          expect(await layoutProblems(page), `${view.name} at ${width}`).toEqual([]);
          await applyLongLabel(page);
          expect(await layoutProblems(page), `${view.name} at ${width}, long label`).toEqual([]);
          if (view.name === 'all' && width >= 1280) {
            // The desk status column fits the longest stage whole, clear of the next column (colors-6.png).
            const fit = await page.locator(`[data-desk-table] [data-request-id="${ROW(7).id}"] [data-col="status"]`).evaluate((cell) => {
              const spans = [...cell.querySelectorAll('span')];
              const next = cell.nextElementSibling?.getBoundingClientRect().left ?? Infinity;
              return {
                text: cell.textContent,
                whole: spans.every((s) => s.scrollWidth <= s.clientWidth + 1),
                clear: Math.max(...spans.map((s) => s.getBoundingClientRect().right)) <= next,
              };
            });
            expect(fit).toEqual({
              text: 'Not found in medical· 2 checks',
              whole: true,
              clear: true,
            });
          }
        }
      } finally {
        await ctx.close();
      }
    });
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`axe and 44 px targets on every stage (${theme})`, async ({ browser }) => {
      test.setTimeout(90_000);
      const ctx = await newSignedInContext(
        browser,
        {
          staffName: 'Dana Kim',
          team: 'GC/HX - Special Operations/Med Transpo',
        },
        {
          viewport: { width: 390, height: 844 },
          bypassCSP: true,
          serviceWorkers: 'block',
          hasTouch: true,
          isMobile: true,
        },
      );
      const page = await ctx.newPage();
      try {
        await serveFixture(page, theme);
        for (const view of VIEWS) {
          await page.goto(view.path);
          await expect(view.ready(page)).toBeVisible({ timeout: 20_000 });
          expect(await axeViolations(page), `${view.name} (${theme})`).toEqual([]);
          expect(await smallTargets(page, '[data-view], [data-testid="profile"]'), `${view.name} targets`).toEqual([]);
        }
      } finally {
        await ctx.close();
      }
    });
  }

  test('screenshots (LP_F5_SHOTS=1): list, Pending (due + Later), held request, front of house card, desktop', async ({ browser }, info) => {
    test.skip(process.env.LP_F5_SHOTS !== '1' || info.project.name !== 'chromium-iphone14', 'set LP_F5_SHOTS=1 (Chromium) to write design/screens/f5-*.png');
    test.setTimeout(180_000);
    const dir = join(ROOT, 'design/screens');
    mkdirSync(dir, { recursive: true });
    const shots: Array<{
      name: string;
      path: string;
      ready: (p: Page) => ReturnType<Page['locator']>;
      staff: TestStaff;
      setup?: (p: Page) => Promise<void>;
    }> = [
      {
        name: 'list',
        path: '/',
        ready: (p) => p.locator(`[data-request-id="${ROW(13).id}"]`).first(),
        staff: { staffName: 'Rae Chen', team: 'Medical' },
      },
      {
        name: 'pending',
        path: '/?view=pending',
        ready: (p) => p.getByTestId('later-group').first(),
        staff: { staffName: 'Rae Chen', team: 'Medical' },
      },
      {
        name: 'held-request',
        path: `/?r=${ROW(13).id}`,
        ready: (p) => p.getByTestId('recheck-row'),
        staff: { staffName: 'Rae Chen', team: 'Medical' },
      },
      {
        name: 'foh-card',
        path: '/?view=mine',
        ready: (p) => p.locator(`[data-testid="stage-chip"], [data-desk-table] [data-request-id="${ROW(13).id}"]`).first(),
        staff: {
          staffName: 'Dana Kim',
          team: 'GC/HX - Special Operations/Med Transpo',
        },
      },
    ];
    for (const theme of ['light', 'dark'] as const) {
      for (const [w, h] of [
        [390, 844],
        [1440, 900],
      ] as const) {
        for (const shot of shots) {
          const ctx = await newSignedInContext(browser, shot.staff, {
            viewport: { width: w, height: h },
            deviceScaleFactor: w < 768 ? 2 : 1,
            serviceWorkers: 'block',
            ...(w < 768 ? { isMobile: true, hasTouch: true } : {}),
          });
          const page = await ctx.newPage();
          try {
            await serveFixture(page, theme);
            await page.goto(shot.path);
            await expect(shot.ready(page)).toBeVisible({ timeout: 20_000 });
            if (shot.name === 'list') {
              const fold = page.getByTestId('closed-fold').first();
              if ((await fold.getAttribute('aria-expanded')) === 'false') await fold.click();
            }
            await page.waitForTimeout(400);
            const name = `f5-${shot.name}-${w}x${h}-${theme}.png`;
            await page.screenshot({
              path: join(dir, w >= 768 && shot.name === 'list' ? name.replace('f5-list', 'f5-desktop') : name),
            });
          } finally {
            await ctx.close();
          }
        }
      }
    }
  });
});
