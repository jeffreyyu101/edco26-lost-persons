import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { axeViolations, overlappingTargets, smallTargets } from './helpers/a11y';
import { syntheticPng } from './helpers/png';
import { signedInAs } from './helpers/session';
import { syncRows } from './helpers/sync';

// New request / Edit on tablet and desktop (design/screens/desktop-new-tablet.html frame 1):
//   1024 px and up   a centred 760 px two-column modal (520 px for a one-section edit)
//   768–1023         a 480 px side sheet over the right side, one column, footer pinned
//   under 768        the phone page, unchanged (tests/e2e/new-request.spec.ts covers it in full)
// Esc, × and a click outside close without discarding (a new request keeps its draft); Cancel asks as on
// the phone; ⌘/Ctrl+↵ sends. Runs against the production build (`npm run build:test`). Synthetic data
// only: every request is named TEST-form-<run>-<n> and is closed again after each test.

const RUN = Date.now().toString(36);
let seq = 0;
const uniqueName = (label: string) => `TEST-form-${RUN}-${(seq += 1)} ${label}`;
const STAFF = { staffName: `TEST-form Desk ${RUN}`, team: 'GC/HX - Dispatch' };
const ORIGIN = new URL(testBaseUrl()).origin;

const DESKTOP = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };
const IPAD_LANDSCAPE = { viewport: { width: 1180, height: 820 }, isMobile: false, hasTouch: true };
const IPAD_PORTRAIT = { viewport: { width: 820, height: 1180 }, isMobile: false, hasTouch: true };

// ---- Locators -------------------------------------------------------------------------------------

const modal = (page: Page, name: string | RegExp = 'New request') => page.getByRole('dialog', { name });
// Closed means unmounted. (A role query alone can't say so: while a confirm is open, Radix hides the
// form's dialog from the accessibility tree.)
const form = (page: Page) => page.getByTestId('request-form');
const submit = (page: Page) => page.getByTestId('request-form-submit');
const person = (page: Page) => page.getByRole('group', { name: 'Missing person' });
const friend = (page: Page) => page.getByRole('group', { name: 'Friend or family' });
const personName = (page: Page) => person(page).getByLabel('Name', { exact: true });
const lastSeen = (page: Page) => page.getByRole('textbox', { name: 'Last seen' });
const postChip = (page: Page) => page.getByRole('button', { name: /^Reporting from/ });

async function openNew(page: Page) {
  await page.goto('/?new=1');
  await expect(modal(page)).toBeVisible();
  await expect(submit(page)).toBeVisible();
}

/** The element's box once the dialog's open animation (a scale / slide) has finished. */
async function box(page: Page, locator: ReturnType<Page['locator']>) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const b = await locator.boundingBox();
  expect(b, 'element has a box').not.toBeNull();
  return b!;
}

// ---- API helpers (the same session as the page) -----------------------------------------------------

interface Row {
  id: string;
  name: string;
  rowVersion: number;
  status: string;
  caseNumber: number;
  [key: string]: unknown;
}

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function apiCreate(request: APIRequestContext, body: Record<string, unknown>): Promise<Row> {
  const res = await request.post('/api/requests', {
    headers: { Origin: ORIGIN },
    data: { clientMutationId: crypto.randomUUID(), reportingLocation: 'FA 3 – Kinetic', ...body },
  });
  expect(res.ok()).toBe(true);
  const row = ((await res.json()) as { request: Row }).request;
  created.push({ id: row.id, request });
  return row;
}

async function apiDetail(request: APIRequestContext, id: string): Promise<Row & { photos: unknown[] }> {
  const res = await request.get(`/api/requests/${id}`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as Row & { photos: unknown[] };
}

async function rowsNamed(request: APIRequestContext, name: string): Promise<Row[]> {
  return (await syncRows<Row>(request)).filter((r) => r.name === name);
}

// ---- Setup ----------------------------------------------------------------------------------------

let errors: string[];

signedInAs(STAFF);

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
});

test.afterEach(async () => {
  expect(errors).toEqual([]);
  // Nothing these tests log stays in Pending.
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await apiDetail(request, id);
      if (row.status === 'Added') {
        await request.post(`/api/requests/${id}/cancel`, { headers: { Origin: ORIGIN }, data: { expectedVersion: row.rowVersion } });
      }
    } catch {
      // Best effort.
    }
  }
});

// ---- Desktop: the centred modal ---------------------------------------------------------------------

test.describe('desktop, 1440 × 900', () => {
  test.use(DESKTOP);

  test('a centred two-column modal; the post chip drops the picker; ⌘↵ sends, with a photo', async ({ page }) => {
    const name = uniqueName('modal');
    await openNew(page);

    // 760 px, centred, 84 px from the top; Missing person left of Friend or family.
    const frame = await box(page, modal(page));
    expect(Math.round(frame.width)).toBe(760);
    expect(Math.abs(frame.x + frame.width / 2 - 720)).toBeLessThanOrEqual(1);
    expect(Math.round(frame.y)).toBe(84);
    const left = await box(page, person(page));
    const right = await box(page, friend(page));
    expect(left.x + left.width).toBeLessThanOrEqual(right.x);
    expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);

    // Typing starts in Name; the place chips are on screen without focusing Last seen; Send shows ⌘↵.
    await expect(personName(page)).toBeFocused();
    await expect(page.getByRole('button', { name: 'kineticFIELD' })).toBeVisible();
    await expect(submit(page).locator('kbd')).toHaveText(/^(⌘↵|Ctrl ↵)$/);
    await expect(submit(page)).toHaveAttribute('aria-keyshortcuts', /^(Meta|Control)\+Enter$/);
    await expect(submit(page)).toHaveAccessibleName('Send request');

    // ⌘↵ while Send is disabled sends nothing.
    let posts = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/requests')) posts += 1;
    });
    await page.keyboard.press('ControlOrMeta+Enter');
    await page.waitForTimeout(300);
    expect(posts).toBe(0);
    await expect(modal(page)).toBeVisible();

    // The chip drops the same picker; Esc closes only the picker.
    await postChip(page).click();
    const picker = page.getByRole('dialog', { name: 'Reporting from' });
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(modal(page)).toBeVisible();
    await postChip(page).click();
    await picker.locator('label', { hasText: 'FA 4 – Oasis' }).click();
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect(picker).toBeHidden();
    await expect(page.getByRole('button', { name: 'Reporting from FA 4 – Oasis. Change' })).toBeVisible();

    await personName(page).fill(name);
    await person(page).getByLabel('Age', { exact: true }).fill('19');
    await page.getByRole('radio', { name: 'Female', exact: true }).click();
    await page.getByLabel('Wearing').fill('TEST-form pink hat, silver fringe top');
    // A chip clicked from another field appends to Last seen and takes the caret there.
    await personName(page).focus();
    await page.getByRole('button', { name: 'kineticFIELD' }).click();
    await expect(lastSeen(page)).toHaveValue('kineticFIELD');
    await expect(lastSeen(page)).toBeFocused();
    await page.keyboard.type(', ~10:30');
    await friend(page).getByLabel('Name').fill('TEST-form Maya R.');
    await friend(page).getByLabel('Phone').fill('(407) 555-0142');
    await expect(page.getByRole('img', { name: 'Valid number' })).toBeVisible();
    await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: syntheticPng() });
    await expect(page.getByRole('button', { name: /^1 photo, today/ })).toBeVisible();

    await friend(page).getByLabel('Phone').focus();
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.getByText(/^LP-\d{4,} saved$/)).toBeVisible();
    await expect(form(page)).toHaveCount(0);
    expect(posts).toBe(1);

    await expect.poll(async () => (await rowsNamed(page.request, name)).length).toBe(1);
    const [row] = await rowsNamed(page.request, name);
    created.push({ id: row!.id, request: page.request });
    expect(row).toMatchObject({
      reportingLocation: 'FA 4 – Oasis',
      age: 19,
      gender: 'Female',
      clothing: 'TEST-form pink hat, silver fringe top',
      lastSeen: 'kineticFIELD, ~10:30',
      contactName: 'TEST-form Maya R.',
      contactPhone: '(407) 555-0142',
    });
    await expect.poll(async () => (await apiDetail(page.request, row!.id)).photos.length, { timeout: 20_000 }).toBe(1);
  });

  test('Esc, × and a click outside keep the draft; Cancel discards it', async ({ page }) => {
    const name = uniqueName('draft');
    await openNew(page);
    await personName(page).fill(name);
    await page.waitForTimeout(600); // the store debounces draft saves by 300 ms

    await page.keyboard.press('Escape');
    await expect(form(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(/new=1/);
    await openNew(page);
    await expect(personName(page)).toHaveValue(name);

    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(form(page)).toHaveCount(0);
    await openNew(page);
    await expect(personName(page)).toHaveValue(name);

    await page.mouse.click(40, 450); // the scrim, left of the modal
    await expect(form(page)).toHaveCount(0);
    await openNew(page);
    await expect(personName(page)).toHaveValue(name);

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Discard this request?');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
    await expect(form(page)).toHaveCount(0);
    await openNew(page);
    await expect(personName(page)).toHaveValue('');
    expect(await rowsNamed(page.request, name)).toHaveLength(0);
  });

  test('Tab stays inside the modal', async ({ page }) => {
    await openNew(page);
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="request-form"]'))).toBe(true);
    }
  });

  test('edit is a one-column modal; Esc asks before dropping changes; ⌘↵ saves only the changed keys', async ({ page }) => {
    const name = uniqueName('edit');
    const row = await apiCreate(page.request, { name, clothing: 'TEST-form black tee', contactName: 'TEST-form Jo', contactPhone: '407 555 0100' });
    const title = `Edit LP-${String(row.caseNumber).padStart(4, '0')}`;
    await page.goto(`/?r=${row.id}&edit=friend`);
    await expect(modal(page, title)).toBeVisible();
    expect(Math.round((await box(page, modal(page, title))).width)).toBe(520);
    await expect(person(page)).toHaveCount(0);
    await expect(submit(page)).toBeDisabled();

    await friend(page).getByLabel('Phone').fill('407 555 0199');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toContainText('Discard changes?');
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(modal(page, title)).toBeVisible();
    await expect(friend(page).getByLabel('Phone')).toHaveValue('407 555 0199');

    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/requests/${row.id}`));
    await friend(page).getByLabel('Phone').focus();
    await page.keyboard.press('ControlOrMeta+Enter');
    expect((await patch).postDataJSON()).toEqual({ patch: { contactPhone: '407 555 0199' }, expectedVersion: row.rowVersion });
    await expect(page).toHaveURL(new RegExp(`\\?r=${row.id}$`));
    await expect(form(page)).toHaveCount(0);
    expect(await apiDetail(page.request, row.id)).toMatchObject({ contactPhone: '407 555 0199', contactName: 'TEST-form Jo' });
  });
});

// ---- Accessibility: axe in both themes, no overlapping targets ---------------------------------------

test.describe('accessibility', () => {
  test.use({ bypassCSP: true, serviceWorkers: 'block' });

  async function settle(page: Page) {
    await page.waitForTimeout(400);
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  }

  for (const theme of ['light', 'dark'] as const) {
    for (const [label, size] of [
      ['desktop', DESKTOP],
      ['iPad portrait', IPAD_PORTRAIT],
    ] as const) {
      test.describe(`${label}, ${theme}`, () => {
        test.use(size);

        test('the form and its post picker pass axe; controls never overlap; 44 px targets on touch', async ({ page }) => {
          await page.addInitScript((t) => {
            try {
              localStorage.setItem('lp-theme', t);
            } catch {
              // Private mode.
            }
          }, theme);
          await openNew(page);
          await personName(page).fill(uniqueName('a11y'));
          await page.getByRole('button', { name: 'More details' }).click();
          await settle(page);
          expect(await axeViolations(page)).toEqual([]);
          expect(await overlappingTargets(page, '[data-testid="request-form"]')).toEqual([]);
          if (size.hasTouch) expect(await smallTargets(page, '[data-testid="request-form"]')).toEqual([]);

          await postChip(page).click();
          await expect(page.getByRole('dialog', { name: 'Reporting from' })).toBeVisible();
          await settle(page);
          expect(await axeViolations(page)).toEqual([]);
          await page.keyboard.press('Escape');
        });
      });
    }
  }
});

// ---- iPad: the side sheet, and the modal on touch -----------------------------------------------------

test.describe('iPad portrait, 820 × 1180', () => {
  test.use(IPAD_PORTRAIT);

  test('a 480 px sheet over the right side, one column, footer pinned; a tap outside keeps the draft', async ({ page }) => {
    const name = uniqueName('sheet');
    await openNew(page);
    const frame = await box(page, modal(page));
    expect(Math.round(frame.width)).toBe(480);
    expect(Math.round(frame.x + frame.width)).toBe(810);
    expect(Math.round(frame.y)).toBe(10);
    expect(Math.round(frame.y + frame.height)).toBe(1170);
    const top = await box(page, person(page));
    const below = await box(page, friend(page));
    expect(below.y).toBeGreaterThan(top.y + top.height - 1);
    expect(Math.abs(below.x - top.x)).toBeLessThanOrEqual(1);
    // Footer pinned at the bottom of the sheet; no key cap on a touch screen.
    const send = await box(page, submit(page));
    expect(send.y + send.height).toBeGreaterThan(1170 - 60);
    await expect(submit(page).locator('kbd')).toBeHidden();

    await personName(page).fill(name);
    await page.waitForTimeout(600);
    await page.touchscreen.tap(100, 600); // the list side, outside the sheet
    await expect(form(page)).toHaveCount(0);
    await openNew(page);
    await expect(personName(page)).toHaveValue(name);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
    await expect(form(page)).toHaveCount(0);
  });
});

test.describe('iPad landscape, 1180 × 820', () => {
  test.use(IPAD_LANDSCAPE);

  test('the two-column modal, with 44 px targets on touch', async ({ page }) => {
    await openNew(page);
    expect(Math.round((await box(page, modal(page))).width)).toBe(760);
    expect(await smallTargets(page, '[data-testid="request-form"]')).toEqual([]);
    expect(await overlappingTargets(page, '[data-testid="request-form"]')).toEqual([]);
  });
});

// ---- Phone: unchanged ------------------------------------------------------------------------------

test('under 768 px New request is still the full-screen page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?new=1');
  await expect(submit(page)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const frame = await box(page, page.getByTestId('request-form'));
  expect([frame.x, frame.y, frame.width, frame.height].map(Math.round)).toEqual([0, 0, 390, 844]);
  await expect(page.getByRole('button', { name: /^Reporting from/ })).toBeVisible();
  await expect(submit(page).locator('kbd')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\?new=1$/);
});
