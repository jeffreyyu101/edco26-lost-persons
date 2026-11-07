import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Browser, type BrowserContextOptions, type Locator, type Page } from '@playwright/test';
import type { AuditEvent, RequestDetail, RequestSummary } from '../../lib/api-types';
import { NOT_FOUND_YET_LABEL, STATUS, STATUS_META, initials } from '../../lib/domain';
import { NOT_FOUND_FINAL_LABEL, RECHECK_DUE_LABEL } from '../../lib/stages';
import { ROOT, testBaseUrl } from '../../scripts/test-env.mjs';
import { axeViolations, overlappingTargets, smallTargets } from './helpers/a11y';
import { newSignedInContext, signedInAs, type TestStaff } from './helpers/session';

// Pending v9.1 (Brian 2026-11-06 19:35–20:40, design/screens/pending-v9.html), end to end:
//   * a fixture (page.route on /api/sync and the request) shaped like the approved frames, at 4:31 PM: Pending on
//     the phone (one page, Waiting for check longest wait first with the held / due rows in place, Friend coming
//     in arrived → en route → nobody order, the folds and their memory, the empty Waiting header), the desk
//     board (two columns that scroll on their own), All and My requests' "⇅" status toggle (groups, the live
//     region, remembered per view), the desk table's header sort, overflow at 375 / 390 / 820 / 1180 / 1440 px in
//     light and dark, axe, and the screenshots (LP_V9_SHOTS=1 writes design/screens/v9-*.png);
//   * the real flow on the real store, API and database: the first Not found holds (chip, "× Not located", the
//     toast), the clock passes the recheck time (the chip turns "Recheck due", nothing moves), the final Not found
//     closes it (the card animates out, the toast, Undo brings it back).
// Synthetic rows only.

const BASE = testBaseUrl();
const MEDIC: TestStaff = { staffName: 'TEST-V9 Medic', team: 'Medical' };
const DANA: TestStaff = { staffName: 'Dana Kim', team: 'GC/HX - Special Operations/Med Transpo' };
const CLOSED_WORDS = STATUS_META[STATUS.notInMedical].label.toLowerCase();

test.use({ serviceWorkers: 'block' });

// ---------------------------------------------------------------------------------------------------
// The fixture (design/screens/pending-v9.html's data, now = 4:31 PM in New York)
// ---------------------------------------------------------------------------------------------------

const T0 = Date.parse('2026-11-06T21:31:00Z');
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const FIX_STAFF = 'Dana Kim · GC/HX - Special Operations/Med Transpo';
const RAE = 'Rae Chen · Medical';

function row(n: number, name: string, over: Record<string, unknown>): RequestSummary {
  return {
    id: `f9000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    clientMutationId: null,
    caseNumber: n,
    firstName: name,
    lastName: null,
    age: '23',
    gender: 'Female',
    heightBuild: null,
    hair: null,
    identifyingFeatures: null,
    physicalDescription: null,
    lastSeen: null,
    clothing: 'Neon green bikini top, white platform boots, red bandana',
    additionalNotes: null,
    reportingLocation: 'FA 4 – Oasis',
    otherLocation: null,
    contactName: 'Chris P.',
    contactPhone: null,
    contactRelationship: 'boyfriend',
    contactNotes: null,
    status: STATUS.waiting,
    createdBy: FIX_STAFF,
    updatedBy: FIX_STAFF,
    createdAt: iso(-10),
    updatedAt: iso(-10),
    foundAt: null,
    reunionStartedAt: null,
    closedAt: null,
    rowVersion: 1,
    firstPhotoId: null,
    photoCount: 0,
    name,
    postShort: 'FA 4',
    medicalLocation: null,
    recheckAt: null,
    notFoundChecks: 0,
    ...over,
  } as RequestSummary;
}

const held = (createdMin: number, heldMin: number) => ({
  createdAt: iso(createdMin),
  recheckAt: iso(heldMin + 20),
  notFoundChecks: 1,
  updatedBy: RAE,
  updatedAt: iso(heldMin),
  rowVersion: 2,
});
const inMed = (foundMin: number, over: Record<string, unknown> = {}) => ({
  status: STATUS.inMedical,
  createdAt: iso(foundMin - 20),
  foundAt: iso(foundMin),
  reunionStartedAt: iso(foundMin),
  updatedBy: RAE,
  updatedAt: iso(foundMin),
  rowVersion: 3,
  ...over,
});

const WAITING_FIX: RequestSummary[] = [
  row(6, 'P.V.', { ...held(-51, -11), age: '30', gender: 'Male', clothing: 'Black bucket hat, silver chain', reportingLocation: 'Command', postShort: 'Command' }),
  row(7, 'S.O.', { ...held(-47, -15), age: '28', gender: 'Male', clothing: 'Orange bandana, white tank top', reportingLocation: 'FA 3 – Kinetic', postShort: 'FA 3' }),
  row(9, 'M.R.', { ...held(-40, -25), age: '22', clothing: 'Pink tutu, silver body glitter' }),
  row(10, 'B.W.', { createdAt: iso(-27) }),
  row(13, 'K.T.', { createdAt: iso(-16), age: '19', clothing: 'Butterfly wings, light-up shoes, blue braids', reportingLocation: 'FA 3 – Kinetic', postShort: 'FA 3' }),
  // F3's fields (read loosely): medical asked, front of house's turn.
  row(14, 'J.D.', {
    createdAt: iso(-9),
    age: 'mid-20s',
    gender: 'Male',
    clothing: 'Red hoodie, black joggers',
    needsInfo: true,
    lastMessage: { by: 'Rae C.', mine: false, text: 'Any tattoos or marks?' },
    lastMessageAt: iso(-6),
  }),
  row(15, 'E.N.', { createdAt: iso(-1), gender: null, clothing: 'Neon green bucket hat, mesh top' }),
];
const COMING_FIX: RequestSummary[] = [
  // Deliberately out of order: R.P. found last, A.L. en route, M.P. arrived (found first).
  row(12, 'R.P.', inMed(-2, { age: '30', gender: 'Male', reportingLocation: 'Base', postShort: 'Base' })),
  row(11, 'A.L.', inMed(-7, { age: '21', medicalLocation: 'Chair 14', enroute: { count: 1, earliestEta: iso(4), state: 'enroute', mine: null } })),
  row(8, 'M.P.', inMed(-26, { age: '26', gender: 'Male', medicalLocation: 'Bed 3 · triage', enroute: { count: 0, earliestEta: null, state: 'arrived', mine: null } })),
];
const CLOSED_FIX: RequestSummary[] = [
  row(5, 'T.N.', { status: STATUS.notInMedical, createdAt: iso(-90), notFoundChecks: 2, updatedBy: RAE, updatedAt: iso(-30), rowVersion: 3 }),
  row(4, 'L.G.', { status: STATUS.reunited, createdAt: iso(-120), closedAt: iso(-60), updatedAt: iso(-60), rowVersion: 4 }),
  row(3, 'D.F.', { status: STATUS.cancelled, createdAt: iso(-130), closedAt: iso(-100), updatedAt: iso(-100), rowVersion: 2 }),
];
const ALL_FIX = [...WAITING_FIX, ...COMING_FIX, ...CLOSED_FIX];
const BY_NAME = new Map(ALL_FIX.map((r) => [r.name, r]));
const idOf = (name: string) => (BY_NAME.get(name) as RequestSummary).id;
const ids = (names: string[]) => names.map(idOf);

function detailOf(r: RequestSummary): RequestDetail {
  const audit: AuditEvent[] = [
    { id: `${r.id}-c`, at: r.createdAt, staff: FIX_STAFF, notes: null, action: 'created', previous: null, next: { reportingLocation: r.reportingLocation, otherLocation: null } },
  ];
  if (r.recheckAt) {
    audit.push({
      id: `${r.id}-h`,
      at: new Date(Date.parse(r.recheckAt) - 20 * 60_000).toISOString(),
      staff: RAE,
      notes: null,
      action: 'status',
      previous: { status: STATUS.waiting },
      next: { status: STATUS.waiting, kind: 'answer', held: true, hold: { recheckAt: r.recheckAt, checks: 1 } },
    });
  }
  return { ...r, photos: [], audit };
}

interface Served {
  rows: RequestSummary[];
}

/** Serves `served.rows` as the synced rows (and their details) at 4:31 PM. Mutate `served.rows` to change them. */
async function serve(page: Page, served: Served, theme: 'light' | 'dark' = 'light') {
  await page.clock.install({ time: T0 });
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('lp-theme', t);
    } catch {}
  }, theme);
  await page.route('**/api/sync**', async (route) => {
    const url = new URL(route.request().url());
    const want = url.searchParams.get('ids');
    const rows = want ? served.rows.filter((r) => want.split(',').includes(r.id)) : served.rows;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        serverTime: new Date(T0).toISOString(),
        rows,
        hasMore: false,
        next: null,
        ...(url.searchParams.get('reconcile') === '1' ? { versions: served.rows.map((r) => [r.id, r.rowVersion]) } : {}),
      }),
    });
  });
  await page.route(/\/api\/requests\/f9000000-[^/?]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop() as string;
    const r = served.rows.find((x) => x.id === id);
    await route.fulfill(r ? { status: 200, contentType: 'application/json', body: JSON.stringify(detailOf(r)) } : { status: 404, body: '{}' });
  });
}

const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: 'block' };
const viewportFor = (width: number): BrowserContextOptions => ({
  viewport: { width, height: width < 768 ? 844 : width < 1024 ? 1180 : 900 },
  isMobile: width < 768,
  hasTouch: width < 1280,
  deviceScaleFactor: 1,
  serviceWorkers: 'block',
});

async function withPage<T>(browser: Browser, staff: TestStaff, options: BrowserContextOptions, fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx = await newSignedInContext(browser, staff, options);
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

/** The ids of the cards under a locator, in order. */
const cardIds = (scope: Locator, testId: string) => scope.locator(`[data-testid="${testId}"]`).evaluateAll((els) => els.map((el) => el.getAttribute('data-pending-card')));
/** The ids of the log / table rows under a locator, in order. */
const rowIds = (scope: Locator) => scope.locator('[data-request-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-request-id')));

// ---------------------------------------------------------------------------------------------------
// Pending, phone
// ---------------------------------------------------------------------------------------------------

test.describe('fixture', () => {
  signedInAs(DANA);

  test('phone: one page — Waiting for check (longest wait first, holds in place, no times) then Friend coming; no tabs, no Later', async ({ browser }) => {
    await withPage(browser, DANA, PHONE, async (page) => {
      await serve(page, { rows: [...ALL_FIX] });
      await page.goto('/?view=pending');
      const waitSec = page.getByTestId('pending-section-check');
      await expect(waitSec.locator('[data-testid="check-card"]').first()).toBeVisible({ timeout: 20_000 });

      // One page: the two sections, in this order; no SegmentedControl, no Later, no sort control.
      await expect(page.getByTestId('pending-tabs')).toHaveCount(0);
      await expect(page.getByRole('tab')).toHaveCount(0);
      await expect(page.getByTestId('later-group')).toHaveCount(0);
      await expect(page.getByTestId('sort-toggle')).toHaveCount(0);
      const sections = await page.locator('[data-testid^="pending-section-"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-queue')));
      expect(sections).toEqual(['check', 'coming']);
      await expect(page.getByRole('heading', { level: 2, name: 'Waiting for check 7 requests' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: 'Friend coming 3 requests' })).toBeVisible();
      // Pending 10 = Waiting (held included) + Friend coming.
      await expect(page.getByTestId('view-switcher')).toContainText('10');

      // Rule 2: one order, longest wait first; held and due rows stay where their wait puts them.
      expect(await cardIds(waitSec, 'check-card')).toEqual(ids(['P.V.', 'S.O.', 'M.R.', 'B.W.', 'K.T.', 'J.D.', 'E.N.']));
      const card = (n: string) => waitSec.locator(`[data-pending-card="${idOf(n)}"]`);
      await expect(card('P.V.').getByTestId('hold-chip')).toHaveText(NOT_FOUND_YET_LABEL);
      await expect(card('P.V.').getByTestId('hold-chip')).not.toHaveAttribute('data-due', '');
      await expect(card('M.R.').getByTestId('hold-chip')).toHaveText(RECHECK_DUE_LABEL);
      await expect(card('M.R.').getByTestId('hold-chip')).toHaveAttribute('data-due', '');
      await expect(card('B.W.').getByTestId('hold-chip')).toHaveCount(0);
      // The wait is the only time: heat-coloured, and no recheck or "not found" time anywhere on a card.
      await expect(card('P.V.').getByTestId('card-minutes')).toHaveText('51m');
      await expect(card('P.V.').getByTestId('card-minutes')).toHaveAttribute('data-tone', 'red');
      await expect(card('K.T.').getByTestId('card-minutes')).toHaveAttribute('data-tone', 'amber');
      for (const text of await waitSec.locator('[data-testid="check-card"]').allTextContents()) {
        expect(text).not.toMatch(/\d:\d\d|Recheck \d|not located \d/i);
      }

      // The left answer: "Not located yet" (the hold) on a fresh card, "× Not located" (closes it) once held or due.
      const answer = (n: string) => card(n).getByTestId('not-found-answer');
      await expect(answer('B.W.')).toHaveText(NOT_FOUND_YET_LABEL);
      await expect(answer('B.W.')).toHaveAccessibleName('Not located yet. Keeps this request open and schedules a recheck');
      await expect(answer('P.V.')).toHaveText(NOT_FOUND_FINAL_LABEL);
      await expect(answer('P.V.')).toHaveAccessibleName(`Not located. Closes this request as ${CLOSED_WORDS}`);
      await expect(answer('M.R.')).toHaveText(NOT_FOUND_FINAL_LABEL);
      // Same width and place in both states, 44 px tall.
      const a = (await answer('B.W.').boundingBox())!;
      const b = (await answer('P.V.').boundingBox())!;
      expect(Math.abs(a.width - b.width)).toBeLessThan(1);
      expect(Math.abs(a.x - b.x)).toBeLessThan(1);
      expect(a.height).toBeCloseTo(44, 0);

      // Rule 4: Friend arrived → Friend en route → nobody coming yet; no friend line on the cards.
      const comingSec = page.getByTestId('pending-section-coming');
      expect(await cardIds(comingSec, 'friend-coming-card')).toEqual(ids(['M.P.', 'A.L.', 'R.P.']));
      for (const text of await comingSec.locator('[data-testid="friend-coming-card"]').allTextContents()) {
        expect(text).not.toContain('Chris P.');
        expect(text).not.toContain('boyfriend');
      }
    });
  });

  test('phone: Waiting folds for the session (oldest wait on the header) and opens when its count rises; Friend coming stays folded on this device', async ({ browser }) => {
    await withPage(browser, DANA, PHONE, async (page) => {
      const served = { rows: [...ALL_FIX] };
      await serve(page, served);
      await page.goto('/?view=pending');
      const toggle = page.getByTestId('queue-toggle-check');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 20_000 });
      await expect(page.getByTestId('queue-oldest-wait')).toHaveCount(0);

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('pending-section-check').locator('[data-testid="check-card"]')).toHaveCount(0);
      await expect(page.getByTestId('queue-oldest-wait')).toHaveText(/^51m longest wait/);
      await expect(page.getByTestId('queue-oldest-wait')).toHaveAttribute('data-tone', 'red');
      await expect(toggle).toHaveAccessibleName('Waiting for check 7 requests, longest wait 51 minutes');
      // Friend coming never moves above it.
      const head = (await page.getByTestId('queue-header-check').boundingBox())!;
      const coming = (await page.getByTestId('queue-header-coming').boundingBox())!;
      expect(coming.y).toBeGreaterThan(head.y);

      // Another view and back: still folded (this page session).
      await page.getByTestId('view-switcher').click();
      await page.getByRole('menuitemradio', { name: /^All requests/ }).click();
      await page.getByTestId('view-switcher').click();
      await page.getByRole('menuitemradio', { name: /^Pending/ }).click();
      await expect(page.getByTestId('queue-toggle-check')).toHaveAttribute('aria-expanded', 'false');

      // A new request to check opens it by itself.
      served.rows = [row(16, 'N.W.', { createdAt: iso(0) }), ...served.rows];
      await page.clock.runFor(8_000);
      await expect(page.getByTestId('queue-toggle-check')).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 });
      await expect(page.getByRole('heading', { level: 2, name: 'Waiting for check 8 requests' })).toBeVisible();

      // Friend coming: per device.
      await page.getByTestId('queue-toggle-coming').click();
      await expect(page.getByTestId('pending-section-coming').locator('[data-testid="friend-coming-card"]')).toHaveCount(0);
      await page.reload();
      await expect(page.getByTestId('queue-toggle-coming')).toHaveAttribute('aria-expanded', 'false', { timeout: 20_000 });
      // The Waiting fold was never stored: a new page opens it.
      await expect(page.getByTestId('queue-toggle-check')).toHaveAttribute('aria-expanded', 'true');
      await page.getByTestId('queue-toggle-coming').click();
      await expect(page.getByTestId('queue-toggle-coming')).toHaveAttribute('aria-expanded', 'true');
    });
  });

  test('phone: an empty Waiting keeps its header with 0 (no rows, no text) above Friend coming', async ({ browser }) => {
    await withPage(browser, DANA, PHONE, async (page) => {
      await serve(page, { rows: [...COMING_FIX, ...CLOSED_FIX] });
      await page.goto('/?view=pending');
      const head = page.getByTestId('queue-header-check');
      await expect(head).toBeVisible({ timeout: 20_000 });
      await expect(head).toHaveAttribute('data-zero', '');
      await expect(head).toHaveText(/^Waiting for check0/);
      await expect(head.getByRole('button')).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 2, name: 'Waiting for check, no requests' })).toBeVisible();
      await expect(page.getByTestId('pending-section-check').locator('[data-testid="check-card"]')).toHaveCount(0);
      await expect(page.getByText('Nothing to check')).toHaveCount(0);
      const coming = page.getByTestId('queue-header-coming');
      expect((await coming.boundingBox())!.y).toBeGreaterThan((await head.boundingBox())!.y);
      await expect(page.getByTestId('friend-coming-card')).toHaveCount(3);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // Pending, desk and tablet
  // -------------------------------------------------------------------------------------------------

  test('desk 1440: two columns, each scrolling on its own, headers keep the chevron; J walks Waiting first', async ({ browser }) => {
    await withPage(browser, DANA, viewportFor(1440), async (page) => {
      await serve(page, { rows: [...ALL_FIX] });
      await page.goto('/?view=pending');
      const left = page.getByTestId('pending-column-check');
      const right = page.getByTestId('pending-column-coming');
      await expect(left.locator('[data-testid="check-card"]').first()).toBeVisible({ timeout: 20_000 });
      const l = (await left.boundingBox())!;
      const r = (await right.boundingBox())!;
      expect(r.x).toBeGreaterThan(l.x + l.width);
      expect(Math.abs(r.y - l.y)).toBeLessThan(2);
      await expect(page.getByTestId('later-group')).toHaveCount(0);
      // The glyph and the chevron.
      await expect(page.getByTestId('queue-toggle-check').locator('svg')).toHaveCount(2);
      await expect(page.getByTestId('queue-toggle-coming')).toHaveAttribute('aria-expanded', 'true');

      // The Waiting column scrolls; the page and the other column do not move.
      const scroll = await left.evaluate((el) => ({ overflow: getComputedStyle(el).overflowY, more: el.scrollHeight > el.clientHeight }));
      expect(scroll).toEqual({ overflow: 'auto', more: true });
      await left.hover();
      await page.mouse.wheel(0, 600);
      await expect.poll(() => left.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
      expect(await right.evaluate((el) => el.scrollTop)).toBe(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      // The header pins to the very top of its column, and nothing scrolled under it shows above it (review fix:
      // the column's top padding used to leave a 6 px strip of cards over the pinned header).
      await left.evaluate((el) => {
        el.scrollTop = 157;
      });
      const header = (await page.getByTestId('queue-header-check').boundingBox())!;
      expect(Math.abs(header.y - l.y)).toBeLessThan(1);
      const above = await page.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          return { header: !!el?.closest('[data-testid="queue-header-check"]'), card: !!el?.closest('[data-testid="check-card"]') };
        },
        { x: l.x + l.width / 2, y: l.y + 3 },
      );
      expect(above).toEqual({ header: true, card: false });

      // J walks every card on screen, Waiting for check before Friend coming.
      const order = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-desk-main] [data-request-id]'))
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => el.closest('[data-pending-card]')?.getAttribute('data-testid')),
      );
      expect(order.lastIndexOf('check-card')).toBeLessThan(order.indexOf('friend-coming-card'));

      // Folding a column keeps its header (and the oldest wait).
      await page.getByTestId('queue-toggle-check').click();
      await expect(left.locator('[data-testid="check-card"]')).toHaveCount(0);
      await expect(page.getByTestId('queue-oldest-wait')).toHaveText(/^51m longest wait/);
      await page.getByTestId('queue-toggle-check').click();
    });
  });

  test('tablet 820: the board beside the rail, two columns', async ({ browser }) => {
    await withPage(browser, DANA, viewportFor(820), async (page) => {
      await serve(page, { rows: [...ALL_FIX] });
      await page.goto('/?view=pending');
      await expect(page.getByTestId('desk-rail')).toBeVisible({ timeout: 20_000 });
      const left = (await page.getByTestId('pending-column-check').boundingBox())!;
      const right = (await page.getByTestId('pending-column-coming').boundingBox())!;
      expect(right.x).toBeGreaterThan(left.x + left.width);
      expect(left.width).toBeGreaterThan(320);
    });
  });

  test('board: two columns at every desk width, a request docked beside it included; the answers keep one line', async ({ browser }) => {
    test.setTimeout(120_000);
    // SPEC rule 5 (review fix): the board never stacks from 768 px. [viewport, open a request beside it]
    const cases = [
      [768, 1024, false],
      [1024, 768, true],
      [1180, 820, true],
      [1280, 800, true],
    ] as const;
    for (const [width, height, docked] of cases) {
      await withPage(browser, DANA, { ...viewportFor(width), viewport: { width, height } }, async (page) => {
        await serve(page, { rows: [...ALL_FIX] });
        await page.goto('/?view=pending');
        const left = page.getByTestId('pending-column-check');
        const right = page.getByTestId('pending-column-coming');
        await expect(left.locator('[data-testid="check-card"]').first()).toBeVisible({ timeout: 20_000 });
        if (docked) {
          await page.locator(`[data-pending-card="${idOf('B.W.')}"] [data-request-id]`).click();
          await expect(page.getByTestId('profile')).toBeVisible();
        }
        const where = `${width}×${height}${docked ? ' with a request open' : ''}`;
        const l = (await left.boundingBox())!;
        const r = (await right.boundingBox())!;
        expect(r.x, where).toBeGreaterThan(l.x + l.width);
        expect(Math.abs(r.y - l.y), where).toBeLessThan(2);
        // Each column scrolls on its own: Friend coming is on screen beside Waiting for check.
        await expect(right.locator('[data-testid="friend-coming-card"]').first()).toBeInViewport();
        expect(await left.evaluate((el) => getComputedStyle(el).overflowY), where).toBe('auto');
        // Every answer and its label on one 44 px line, nothing cut.
        const answers = await left.locator('[data-testid="check-card"] button[data-accent-color]').evaluateAll((els) =>
          els.map((el) => ({ text: (el.textContent ?? '').trim(), h: el.getBoundingClientRect().height, cut: el.scrollWidth > el.clientWidth + 1 })),
        );
        expect(answers.length, where).toBeGreaterThan(0);
        for (const a of answers) expect(a, `${where}: ${a.text}`).toMatchObject({ h: 44, cut: false });
        expect(await layoutProblems(page), where).toEqual([]);
      });
    }
  });

  test('desk: the connection banner never pushes the board below the window (the page never scrolls)', async ({ browser }) => {
    const ctx = await newSignedInContext(browser, DANA, viewportFor(1440));
    const page = await ctx.newPage();
    try {
      await serve(page, { rows: [...ALL_FIX] });
      await page.goto('/?view=pending');
      const left = page.getByTestId('pending-column-check');
      await expect(left.locator('[data-testid="check-card"]').first()).toBeVisible({ timeout: 20_000 });
      await ctx.setOffline(true);
      // F2's banner is not a status region (its words are announced once by `live-announcement`); the shell may
      // render a hidden copy, so the visible one.
      await expect(page.getByText(/^Offline · \d+ waiting to send$/).filter({ visible: true })).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight))
        .toBeLessThanOrEqual(0);
      const vh = await page.evaluate(() => window.innerHeight);
      for (const col of ['check', 'coming'] as const) {
        const box = (await page.getByTestId(`pending-column-${col}`).boundingBox())!;
        expect(box.y + box.height, col).toBeLessThanOrEqual(vh + 1);
      }
      // The last card's answers are reachable by scrolling the column.
      await left.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const last = (await left.locator('[data-testid="check-card"]').last().boundingBox())!;
      expect(last.y + last.height).toBeLessThanOrEqual(vh);
    } finally {
      await ctx.setOffline(false);
      await ctx.close();
    }
  });

  // -------------------------------------------------------------------------------------------------
  // Sort by status: All and My requests (phone), the desk table header
  // -------------------------------------------------------------------------------------------------

  test('All requests (phone): "⇅ Newest" ↔ "⇅ Status", groups with dividers, the live region, remembered on this device', async ({ browser }) => {
    await withPage(browser, DANA, PHONE, async (page) => {
      await serve(page, { rows: [...ALL_FIX] });
      await page.goto('/');
      const toggle = page.getByTestId('sort-toggle');
      await expect(toggle).toHaveText('Newest', { timeout: 20_000 });
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await expect(toggle).toHaveAccessibleName('Newest, newest first. Sort by status, waiting for check first');
      const list = page.getByTestId('request-list');
      await expect(list.locator(`[data-request-id="${idOf('E.N.')}"]`)).toBeVisible();
      expect((await rowIds(list)).slice(0, 3)).toEqual(ids(['E.N.', 'J.D.', 'K.T.']));
      // At the right end of the line under the title.
      const t = (await toggle.boundingBox())!;
      expect(t.x + t.width).toBeGreaterThan(390 - 20);
      expect(t.height).toBeCloseTo(32, 0);

      await toggle.click();
      await expect(toggle).toHaveText('Status');
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('sort-announcement')).toHaveText('Sorted by status');
      await expect(page.getByRole('heading', { name: 'Waiting for check 7 requests' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Friend coming 3 requests' })).toBeVisible();
      expect(await rowIds(list)).toEqual(ids(['P.V.', 'S.O.', 'M.R.', 'B.W.', 'K.T.', 'J.D.', 'E.N.', 'M.P.', 'A.L.', 'R.P.']));
      await expect(page.getByTestId('closed-fold')).toHaveAccessibleName('Archived 3 requests');
      await expect(page.getByTestId('closed-fold')).toHaveAttribute('aria-expanded', 'false');
      // The status cell is the stage label: held → Not located yet, due → Recheck due (violet).
      const cell = (n: string) => list.locator(`[data-request-id="${idOf(n)}"] [data-col="status"]`);
      await expect(cell('P.V.')).toHaveText(NOT_FOUND_YET_LABEL);
      await expect(cell('M.R.')).toHaveText(RECHECK_DUE_LABEL);
      await expect(cell('M.R.')).toHaveAttribute('data-tone', 'violet');
      // Archived opens newest closed first.
      await page.getByTestId('closed-fold').click();
      expect(await rowIds(page.getByTestId('closed-rows'))).toEqual(ids(['T.N.', 'L.G.', 'D.F.']));

      // Remembered on this device.
      await page.reload();
      await expect(page.getByTestId('sort-toggle')).toHaveText('Status', { timeout: 20_000 });
      await page.getByTestId('sort-toggle').click();
      await expect(page.getByTestId('sort-toggle')).toHaveText('Newest');
      await expect(page.getByTestId('sort-announcement')).toHaveText('Sorted: newest first');
      await expect(page.getByTestId('group-check')).toHaveCount(0);
    });
  });

  test('My requests (phone): "⇅ Updated" ↔ "⇅ Status", Closed folded last; each view keeps its own order', async ({ browser }) => {
    await withPage(browser, DANA, PHONE, async (page) => {
      await serve(page, { rows: [...ALL_FIX] });
      await page.goto('/?view=mine');
      const toggle = page.getByTestId('sort-toggle');
      await expect(toggle).toHaveText('Updated', { timeout: 20_000 });
      await expect(page.locator('[data-testid="mine-card"]').first()).toBeVisible();
      await toggle.click();
      await expect(toggle).toHaveText('Status');
      await expect(page.getByTestId('sort-announcement')).toHaveText('Sorted by status');
      await expect(page.getByRole('heading', { name: 'Waiting for check 7 requests' })).toBeVisible();
      const waitingIds = await page.getByTestId('mine-group-check').locator('[data-request-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-request-id')));
      expect(waitingIds).toEqual(ids(['P.V.', 'S.O.', 'M.R.', 'B.W.', 'K.T.', 'J.D.', 'E.N.']));
      // A held card: the wait in its corner, the chip under it, no recheck time.
      const pv = page.locator(`[data-testid="mine-card"]:has([data-request-id="${idOf('P.V.')}"])`);
      await expect(pv.getByTestId('hold-chip')).toHaveText(NOT_FOUND_YET_LABEL);
      await expect(pv).not.toContainText('Recheck 4');
      const fold = page.getByTestId('closed-fold');
      await expect(fold).toHaveAccessibleName('Closed 3 requests');
      await expect(fold).toHaveAttribute('aria-expanded', 'false');
      // The row is full width, its › at the right edge (frame 9).
      const foldBox = (await fold.boundingBox())!;
      const sectionBox = (await page.getByTestId('mine-closed').boundingBox())!;
      expect(Math.abs(foldBox.width - sectionBox.width)).toBeLessThan(1);
      const chev = (await fold.locator('svg.lucide-chevron-right').boundingBox())!;
      expect(foldBox.x + foldBox.width - (chev.x + chev.width)).toBeLessThan(24);
      await fold.click();
      await expect(fold.locator('svg.lucide-chevron-down')).toHaveCount(1);
      await expect(page.getByTestId('closed-rows').locator('[data-testid="mine-card"]')).toHaveCount(3);

      // All requests keeps its own order (Newest).
      await page.goto('/');
      await expect(page.getByTestId('sort-toggle')).toHaveText('Newest', { timeout: 20_000 });
      await page.goto('/?view=mine');
      await expect(page.getByTestId('sort-toggle')).toHaveText('Status', { timeout: 20_000 });
      await page.getByTestId('sort-toggle').click();
      await expect(page.getByTestId('sort-announcement')).toHaveText('Sorted: latest update first');
    });
  });

  test('360 px and under: the toggle drops to its own row, left-aligned', async ({ browser }) => {
    await withPage(browser, DANA, { ...PHONE, viewport: { width: 360, height: 780 } }, async (page) => {
      await serve(page, { rows: [...ALL_FIX] });
      await page.goto('/');
      const toggle = page.getByTestId('sort-toggle');
      await expect(toggle).toBeVisible({ timeout: 20_000 });
      const box = (await toggle.boundingBox())!;
      expect(box.x).toBeLessThan(24);
      // (F5 release) Its tap area and Refresh now's above it never reach over each other, nor the header's.
      expect(await overlappingTargets(page)).toEqual([]);
    });
  });

  // (F5 release) F2's header puts search and the avatar right above the toggle at the live line's right end: their
  // tap areas grow up, the toggle's down, so a tap at the seam goes to the control drawn there.
  for (const width of [375, 390, 430] as const) {
    test(`${width} px: the toggle under the header's search and avatar, no tap area over another`, async ({ browser }) => {
      await withPage(browser, DANA, { ...PHONE, viewport: { width, height: 780 } }, async (page) => {
        await serve(page, { rows: [...ALL_FIX] });
        for (const path of ['/', '/?view=mine']) {
          await page.goto(path);
          const toggle = page.getByTestId('sort-toggle');
          await expect(toggle).toBeVisible({ timeout: 20_000 });
          const search = (await page.getByRole('button', { name: 'Search' }).boundingBox())!;
          const box = (await toggle.boundingBox())!;
          expect(box.x + box.width).toBeGreaterThan(search.x);
          expect(await overlappingTargets(page), path).toEqual([]);
        }
      });
    });
  }

  // (Hotfix F5.1, Brian 2026-11-07, pending-v9.html frames 6, 7, 9) The phone header's rhythm: the title row, then the
  // live line 12 px under the search and avatar on every list view (the same place on Pending, which has no toggle),
  // and on All and My requests the "⇅" toggle at the line's right end: a 32 px chip centred on the line's words, its
  // right edge on the avatar's, its 44 px tap area inside the row. At 360 px it drops to its own row, 12 px under.
  for (const theme of ['light', 'dark'] as const) {
    test(`header (${theme}): the toggle centred on the live line, 12 px clear of the avatar, nothing cut, 360–430 px`, async ({ browser }) => {
      test.setTimeout(120_000);
      for (const width of [360, 375, 390, 414, 430] as const) {
        await withPage(browser, DANA, { ...PHONE, viewport: { width, height: 780 } }, async (page) => {
          await serve(page, { rows: [...ALL_FIX] }, theme);
          const lineUnderTitle: Record<string, number> = {};
          for (const path of ['/?view=mine', '/', '/?view=pending']) {
            const at = `${path} at ${width} (${theme})`;
            await page.goto(path);
            await expect(page.getByTestId('live-text')).toHaveText('Updated just now', { timeout: 20_000 });
            // (F3 + F4 release) F4's alerts reminder (an iPhone Safari tab here) loads after start and pushes the
            // header down when it comes: measure once it is there, so every box is from the same layout.
            await expect(page.getByTestId('alerts-banner').filter({ visible: true }), at).toHaveCount(1, { timeout: 20_000 });
            const box = async (l: Locator) => (await l.boundingBox())!;
            const title = await box(page.getByTestId('view-switcher'));
            const avatar = await box(page.getByTestId('account-trigger'));
            const words = await box(page.getByTestId('live-text'));
            const refresh = await box(page.getByTestId('refresh-now'));
            // The line's 32 px row starts 12 px under the avatar, the same distance under the title on every view.
            expect(refresh.y - (avatar.y + avatar.height), at).toBeGreaterThanOrEqual(11.5);
            lineUnderTitle[path] = refresh.y - title.y;
            // Nothing cut: the words are whole (no ellipsis), every control on screen.
            expect(await page.getByTestId('live-text').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), at).toBe(true);
            expect(await overlappingTargets(page), at).toEqual([]);
            if (path.includes('pending')) {
              await expect(page.getByTestId('sort-toggle'), at).toHaveCount(0);
              continue;
            }
            const toggle = page.getByTestId('sort-toggle');
            const chip = await box(toggle);
            expect(chip.height, at).toBe(32);
            expect(chip.x, at).toBeGreaterThanOrEqual(0);
            expect(chip.x + chip.width, at).toBeLessThanOrEqual(width);
            // Its glyph and word inside the chip (its tap area overhangs it, so not scrollWidth).
            const textInside = await toggle.evaluate((el) => {
              const range = document.createRange();
              range.selectNodeContents(el);
              const t = range.getBoundingClientRect();
              const b = el.getBoundingClientRect();
              return t.left >= b.left - 0.5 && t.right <= b.right + 0.5 && t.top >= b.top - 0.5 && t.bottom <= b.bottom + 0.5;
            });
            expect(textInside, at).toBe(true);
            if (width > 360) {
              // At the line's right end: centred on its words, 12 px clear of the avatar, on the avatar's right edge.
              expect(Math.abs(chip.y + chip.height / 2 - (words.y + words.height / 2)), at).toBeLessThanOrEqual(1);
              expect(chip.y - (avatar.y + avatar.height), at).toBeGreaterThanOrEqual(11.5);
              expect(Math.abs(chip.x + chip.width - (avatar.x + avatar.width)), at).toBeLessThanOrEqual(1);
              // Its row is the line's own height (the chip's tap area adds none).
              expect((await box(page.getByTestId('live-row'))).height, at).toBeLessThanOrEqual(38.5);
            } else {
              // Its own row, left-aligned with the line, 12 px under it.
              expect(chip.y - (refresh.y + refresh.height), at).toBeGreaterThanOrEqual(11.5);
              expect(Math.abs(chip.x - title.x), at).toBeLessThanOrEqual(1);
            }
          }
          // The same rhythm on All, My requests and Pending.
          expect(Math.max(...Object.values(lineUnderTitle)) - Math.min(...Object.values(lineUnderTitle)), `${width} (${theme})`).toBeLessThanOrEqual(0.5);
        });
      }
    });
  }

  test('desk table: the header sorts — Created ↓ by default, Status ↓ with group rows and the wait after every waiting label, Created goes back', async ({ browser }) => {
    await withPage(browser, DANA, viewportFor(1440), async (page) => {
      await serve(page, { rows: [...ALL_FIX] });
      await page.goto('/');
      const table = page.locator('[data-desk-table]');
      const status = page.getByTestId('sort-status');
      const created = page.getByTestId('sort-created');
      await expect(created).toBeVisible({ timeout: 20_000 });
      const header = (key: string) => page.locator(`[role="columnheader"][data-col="${key}"]`);
      await expect(header('created')).toHaveAttribute('aria-sort', 'descending');
      await expect(header('status')).not.toHaveAttribute('aria-sort', /.+/);
      await expect(created.locator('svg')).toBeVisible();
      await expect(page.getByTestId('sort-toggle')).toHaveCount(0);

      await status.click();
      await expect(header('status')).toHaveAttribute('aria-sort', 'other');
      await expect(header('created')).not.toHaveAttribute('aria-sort', /.+/);
      await expect(page.getByRole('heading', { name: 'Waiting for check 7 requests' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Friend coming 3 requests' })).toBeVisible();
      expect((await rowIds(table)).slice(0, 10)).toEqual(ids(['P.V.', 'S.O.', 'M.R.', 'B.W.', 'K.T.', 'J.D.', 'E.N.', 'M.P.', 'A.L.', 'R.P.']));
      const cell = (n: string) => table.locator(`[data-request-id="${idOf(n)}"] [data-col="status"]`);
      await expect(cell('B.W.')).toHaveText('Waiting for check· 27m');
      await expect(cell('J.D.')).toHaveText('Needs info· 9m');
      await expect(cell('P.V.')).toHaveText('Not located yet· 51m');
      await expect(cell('M.R.')).toHaveText('Recheck due· 40m');
      await expect(cell('P.V.').locator('[data-tone="red"]')).toHaveCount(1);
      await expect(cell('A.L.')).toHaveText('Friend en route· ~4 min');
      await expect(cell('R.P.')).toHaveText(STATUS_META[STATUS.inMedical].shortLabel);

      // Status again goes back to Created ↓; so does Created.
      await status.click();
      await expect(header('created')).toHaveAttribute('aria-sort', 'descending');
      await status.click();
      await created.click();
      await expect(header('created')).toHaveAttribute('aria-sort', 'descending');
      await expect(page.getByTestId('group-check')).toHaveCount(0);

      // My requests: Updated ↓ by default; remembered per view.
      await page.goto('/?view=mine');
      await expect(header('updated')).toHaveAttribute('aria-sort', 'descending', { timeout: 20_000 });
      await page.getByTestId('sort-status').click();
      await expect(page.getByTestId('closed-fold')).toHaveAccessibleName('Closed 3 requests');
      await page.reload();
      await expect(header('status')).toHaveAttribute('aria-sort', 'other', { timeout: 20_000 });
      await page.getByTestId('sort-updated').click();
      await expect(header('updated')).toHaveAttribute('aria-sort', 'descending');
    });
  });

  // -------------------------------------------------------------------------------------------------
  // Overflow, axe, screenshots
  // -------------------------------------------------------------------------------------------------

  /** Content cut without an ellipsis, anything off screen, a status tag on two lines, or a sideways page. */
  async function layoutProblems(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const out: string[] = [];
      const vw = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${vw}`);
      const label = (el: Element) => `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''} "${(el.textContent ?? '').trim().slice(0, 40)}"`;
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && !cs.clipPath.startsWith('inset(50%');
      };
      const roots = [...document.querySelectorAll<HTMLElement>('[data-view], [data-testid="profile"]')];
      for (const el of roots.flatMap((r) => [...r.querySelectorAll<HTMLElement>('*')])) {
        if (!visible(el) || el.closest('svg') || el.closest('[data-testid="leaving-card"]')) continue;
        const own = el.getBoundingClientRect();
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
        if (!scroller && (right > vw + 1 || left < -1)) out.push(`outside the viewport: ${label(el)}`);
        const cs = getComputedStyle(el);
        const clips = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
        if (clips && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && !el.querySelector('*') && el.textContent?.trim()) out.push(`cut without an ellipsis: ${label(el)}`);
        const parent = el.parentElement;
        if (parent && el.textContent?.trim() && !el.querySelector('*')) {
          const p = parent.getBoundingClientRect();
          if (getComputedStyle(parent).overflowX === 'visible' && (own.right > p.right + 1 || own.left < p.left - 1)) out.push(`wider than its container: ${label(el)}`);
        }
      }
      for (const el of document.querySelectorAll<HTMLElement>('[data-col="status"], [data-testid="hold-chip"], [data-testid="stage-chip"], [data-testid="sort-toggle"], [data-testid^="queue-header-"], [data-testid^="group-"], [data-testid="not-found-answer"]')) {
        if (!visible(el)) continue;
        const lh = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.4;
        if (el.getBoundingClientRect().height > Math.max(lh * 1.6, 46)) out.push(`one-line tag wraps: ${label(el)}`);
      }
      return out;
    });
  }

  const VIEWS = [
    { name: 'pending', path: '/?view=pending', ready: (p: Page) => p.locator('[data-testid="check-card"]').first() },
    { name: 'all-status', path: '/', sort: 'all', ready: (p: Page) => p.getByTestId('group-check') },
    { name: 'mine-status', path: '/?view=mine', sort: 'mine', ready: (p: Page) => p.getByTestId('group-check') },
    { name: 'request', path: `/?r=${idOf('M.R.')}`, ready: (p: Page) => p.getByTestId('status-block') },
  ] as const;

  /** Starts All and My requests sorted by status (the remembered choice). */
  async function sortedByStatus(page: Page) {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('lp-sort-all', 'status');
        localStorage.setItem('lp-sort-mine', 'status');
      } catch {}
    });
  }

  for (const theme of ['light', 'dark'] as const) {
    for (const width of [375, 390, 768, 820, 1180, 1440] as const) {
      test(`overflow at ${width} px (${theme}): Pending, All and My requests by status, the request`, async ({ browser }) => {
        test.setTimeout(90_000);
        await withPage(browser, DANA, viewportFor(width), async (page) => {
          await sortedByStatus(page);
          await serve(page, { rows: [...ALL_FIX] }, theme);
          for (const view of VIEWS) {
            await page.goto(view.path);
            await expect(view.ready(page)).toBeVisible({ timeout: 20_000 });
            expect(await layoutProblems(page), `${view.name} at ${width} (${theme})`).toEqual([]);
          }
        });
      });
    }

    test(`axe and 44 px targets (${theme}): Pending, All and My requests by status, phone and desk`, async ({ browser }) => {
      test.setTimeout(120_000);
      for (const width of [390, 1440] as const) {
        await withPage(browser, DANA, { ...viewportFor(width), bypassCSP: true }, async (page) => {
          await sortedByStatus(page);
          await serve(page, { rows: [...ALL_FIX] }, theme);
          for (const view of VIEWS.slice(0, 3)) {
            await page.goto(view.path);
            await expect(view.ready(page)).toBeVisible({ timeout: 20_000 });
            expect(await axeViolations(page), `${view.name} at ${width} (${theme})`).toEqual([]);
            if (width < 768) expect(await smallTargets(page, '[data-view]'), `${view.name} targets`).toEqual([]);
          }
          // Folded Waiting and the empty header too.
          await page.goto('/?view=pending');
          await page.getByTestId('queue-toggle-check').click();
          expect(await axeViolations(page), `pending folded at ${width} (${theme})`).toEqual([]);
        });
      }
    });
  }

  test('screenshots (LP_V9_SHOTS=1): Pending phone / tablet / desk, folded, empty, All and My by status, desk table by status', async ({ browser }, info) => {
    test.skip(process.env.LP_V9_SHOTS !== '1' || info.project.name !== 'chromium-iphone14', 'set LP_V9_SHOTS=1 (Chromium) to write design/screens/v9-*.png');
    test.setTimeout(300_000);
    const dir = join(ROOT, 'design/screens');
    mkdirSync(dir, { recursive: true });
    const sizes = [
      [390, 844],
      [820, 1180],
      [1440, 900],
    ] as const;
    const shots: Array<{ name: string; path: string; rows?: RequestSummary[]; ready: (p: Page) => Locator; then?: (p: Page) => Promise<void> }> = [
      { name: 'pending', path: '/?view=pending', ready: (p) => p.locator('[data-testid="check-card"]').first() },
      {
        name: 'pending-folded',
        path: '/?view=pending',
        rows: [...WAITING_FIX, ...COMING_FIX.slice(1)],
        ready: (p) => p.getByTestId('queue-toggle-check'),
        then: async (p) => p.getByTestId('queue-toggle-check').click(),
      },
      { name: 'pending-empty', path: '/?view=pending', rows: [...COMING_FIX.slice(1), ...CLOSED_FIX], ready: (p) => p.getByTestId('queue-header-check') },
      { name: 'all-status', path: '/', ready: (p) => p.getByTestId('group-check') },
      { name: 'all-newest', path: '/', ready: (p) => p.locator(`[data-request-id="${idOf('E.N.')}"]`).first() },
      { name: 'mine-status', path: '/?view=mine', ready: (p) => p.getByTestId('group-check') },
    ];
    for (const theme of ['light', 'dark'] as const) {
      for (const [w, h] of sizes) {
        for (const shot of shots) {
          await withPage(
            browser,
            DANA,
            { viewport: { width: w, height: h }, deviceScaleFactor: w < 768 ? 2 : 1, serviceWorkers: 'block', ...(w < 768 ? { isMobile: true, hasTouch: true } : {}) },
            async (page) => {
              if (shot.name !== 'all-newest') await sortedByStatus(page);
              await serve(page, { rows: shot.rows ?? [...ALL_FIX] }, theme);
              await page.goto(shot.path);
              await expect(shot.ready(page)).toBeVisible({ timeout: 20_000 });
              if (shot.then) await shot.then(page);
              await page.waitForTimeout(400);
              await page.screenshot({ path: join(dir, `v9-${shot.name}-${w}x${h}-${theme}.png`) });
            },
          );
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// The real flow (real store, API and database)
// ---------------------------------------------------------------------------------------------------

test.describe('real flow', () => {
  signedInAs(MEDIC);
  const TAG = `TEST-V9-${Date.now().toString(36)}`;
  const made: Array<{ id: string; request: APIRequestContext }> = [];

  async function call<T>(request: APIRequestContext, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
    const res = await request.fetch(path, { method, data, headers: { Origin: BASE } });
    expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBe(true);
    return (await res.json()) as T;
  }

  test.afterEach(async () => {
    for (const { id, request } of made.splice(0)) {
      try {
        const r = await call<RequestDetail>(request, 'GET', `/api/requests/${id}`);
        if (r.status === STATUS.waiting) await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: r.rowVersion }, headers: { Origin: BASE } });
      } catch {
        // Best effort.
      }
    }
  });

  test('first Not found → violet chip + "× Not located" → due (nothing moves) → closes with the toast; Undo brings it back', async ({ page }) => {
    test.setTimeout(120_000);
    await page.clock.install();
    const older = await call<{ request: RequestSummary }>(page.request, 'POST', '/api/requests', {
      clientMutationId: randomUUID(),
      reportingLocation: 'FA 4 – Oasis',
      name: `${TAG} Older`,
      age: '22',
      clothing: `Synthetic ${TAG} older`,
    });
    made.push({ id: older.request.id, request: page.request });
    const { request: r } = await call<{ request: RequestSummary }>(page.request, 'POST', '/api/requests', {
      clientMutationId: randomUUID(),
      reportingLocation: 'FA 4 – Oasis',
      name: `${TAG} B W`,
      age: '23',
      gender: 'Female',
      clothing: `Synthetic ${TAG} bikini top`,
    });
    made.push({ id: r.id, request: page.request });
    const detail = () => call<RequestDetail>(page.request, 'GET', `/api/requests/${r.id}`);

    await page.goto('/?view=pending');
    const card = page.locator(`[data-testid="check-card"][data-pending-card="${r.id}"]`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    const position = () => page.locator('[data-testid="check-card"]').evaluateAll((els, id) => els.findIndex((el) => el.getAttribute('data-pending-card') === id), r.id);
    const before = await position();
    const answer = card.getByTestId('not-found-answer');
    await expect(answer).toHaveText(NOT_FOUND_YET_LABEL);

    // The first Not found: the hold. The chip, the other left answer, the toast; the card stays where it was.
    await answer.click();
    await expect(page.locator('.lp-snack')).toContainText('Not located yet · recheck in 20 min');
    await expect(card.getByTestId('hold-chip')).toHaveText(NOT_FOUND_YET_LABEL);
    await expect(answer).toHaveText(NOT_FOUND_FINAL_LABEL);
    await expect(answer).toHaveAccessibleName(`Not located. Closes this request as ${CLOSED_WORDS}`);
    expect(await position()).toBe(before);
    await expect.poll(async () => (await detail()).notFoundChecks).toBe(1);
    expect((await detail()).status).toBe(STATUS.waiting);

    // 21 minutes later: Recheck due, in place.
    await page.clock.fastForward('21:00');
    await expect(card.getByTestId('hold-chip')).toHaveText(RECHECK_DUE_LABEL);
    expect(await position()).toBe(before);

    // The final Not found closes it: the card animates out of Pending (an inert copy, held here with the clock
    // paused), and the toast says so (in words for screen readers).
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
    await answer.click();
    await expect(card).toHaveCount(0);
    const leaving = page.locator('[data-testid="leaving-card"]');
    await expect(leaving).toHaveCount(1);
    await expect(leaving).toHaveAttribute('aria-hidden', 'true');
    await page.clock.resume();
    const snack = page.locator('.lp-snack');
    const who = initials(r.name);
    await expect(snack).toContainText(`${who} closed · ${CLOSED_WORDS}`);
    await expect(snack.getByText(`${who} closed, ${CLOSED_WORDS}.`)).toBeAttached();
    await expect.poll(async () => (await detail()).status).toBe(STATUS.notInMedical);
    await expect(page.locator('[data-testid="leaving-card"]')).toHaveCount(0);

    // Undo: back in place, still held.
    await snack.getByRole('button', { name: 'Undo' }).click();
    await expect(card).toBeVisible();
    await expect(card.getByTestId('hold-chip')).toBeVisible();
    await expect.poll(async () => (await detail()).status).toBe(STATUS.waiting);
    expect((await detail()).notFoundChecks).toBe(1);
  });

  test('the request (medical): the same two-state answer in the status block', async ({ page }) => {
    const { request: r } = await call<{ request: RequestSummary }>(page.request, 'POST', '/api/requests', {
      clientMutationId: randomUUID(),
      reportingLocation: 'FA 3 – Kinetic',
      name: `${TAG} Block`,
      age: '19',
      clothing: `Synthetic ${TAG} block`,
    });
    made.push({ id: r.id, request: page.request });
    await page.goto(`/?r=${r.id}`);
    const answer = page.getByTestId('block-answers').getByTestId('not-found-answer');
    await expect(answer).toHaveText(NOT_FOUND_YET_LABEL, { timeout: 20_000 });
    await answer.click();
    await expect(page.getByTestId('status-label')).toHaveText(NOT_FOUND_YET_LABEL);
    await expect(answer).toHaveText(NOT_FOUND_FINAL_LABEL);
    await expect(answer).toHaveAccessibleName(`Not located. Closes this request as ${CLOSED_WORDS}`);
  });
});
