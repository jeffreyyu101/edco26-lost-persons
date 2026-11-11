import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { axeViolations, overlappingTargets, smallTargets } from './helpers/a11y';
import { confirmCrop, confirmCrops } from './helpers/photo';
import { syntheticPng } from './helpers/png';
import { signedInAs } from './helpers/session';
import { syncRows } from './helpers/sync';

// New request / Edit on tablet and desktop (design/screens/desktop-new-tablet.html frame 1), in Jeffrey's
// order (DECISIONS.md, 10:31): every field free text, More details right after the missing person and
// always open, Friend or family last and optional, nothing to expand.
//   1024 px and up   a centred 760 px modal: Missing person + More details left, Friend or family right
//                    (520 px, one column, for a one-section edit); the body scrolls between a pinned
//                    header and footer when it doesn't fit
//   768–1023         a 480 px side sheet over the right side, the same order in one column, footer pinned
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
const more = (page: Page) => page.getByRole('group', { name: 'More details' });
const friend = (page: Page) => page.getByRole('group', { name: 'Friend or family' });
const scroller = (page: Page) => form(page).locator('.lp-rf-scroll');
const personName = (page: Page) => person(page).getByLabel('Name', { exact: true });
const lastSeen = (page: Page) => page.getByRole('textbox', { name: 'Last seen' });
const postChip = (page: Page) => page.getByRole('button', { name: /^Reporting from/ });

async function openNew(page: Page) {
  await page.goto('/?new=1');
  await expect(modal(page)).toBeVisible();
  await expect(submit(page)).toBeVisible();
}

/**
 * Every field of the form in DOM order (which is also the Tab and Enter-to-next order), by its accessible
 * label. Jeffrey's order: the missing person, More details, then Friend or family.
 */
async function fieldOrder(page: Page): Promise<string[]> {
  return form(page)
    .locator('.lp-rf-in')
    .evaluateAll((els) =>
      els.map((el) => ((el as HTMLInputElement).labels?.[0]?.textContent ?? el.getAttribute('aria-label') ?? '').trim()),
    );
}
const PERSON_FIELDS = ['Name', 'Age', 'Gender', 'Wearing', 'Last seen'];
const MORE_FIELDS = ['Hair', 'Build', 'Features', 'Description', 'Other notes'];
const FRIEND_FIELDS = ['Name', 'Phone', 'Relation', 'Notes'];

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

    // 760 px, centred, 84 px from the top. Left column: Missing person, then More details under it;
    // right column: Friend or family, level with Missing person.
    const frame = await box(page, modal(page));
    expect(Math.round(frame.width)).toBe(760);
    expect(Math.abs(frame.x + frame.width / 2 - 720)).toBeLessThanOrEqual(1);
    expect(Math.round(frame.y)).toBe(84);
    const left = await box(page, person(page));
    const below = await box(page, more(page));
    const right = await box(page, friend(page));
    expect(left.x + left.width).toBeLessThanOrEqual(right.x);
    expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(below.x - left.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(below.width - left.width)).toBeLessThanOrEqual(1);
    expect(below.y).toBeGreaterThan(left.y + left.height);

    // Nothing to expand: every field is on screen, in Jeffrey's order, and the whole form fits at 1440 × 900.
    expect(await fieldOrder(page)).toEqual([...PERSON_FIELDS, ...MORE_FIELDS, ...FRIEND_FIELDS]);
    await expect(form(page).getByRole('button', { name: /More details/ })).toHaveCount(0);
    for (const label of MORE_FIELDS) await expect(more(page).getByLabel(label, { exact: true })).toBeVisible();
    await expect(more(page).getByText('Other notes', { exact: true })).toBeVisible();
    await expect(friend(page).getByLabel('Notes')).toBeVisible();
    await expect(form(page).getByText('Optional', { exact: true })).toBeVisible();
    expect(await scroller(page).evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0);

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
    // Age is free text.
    await person(page).getByLabel('Age', { exact: true }).fill('mid-20s');
    // Gender is free text with quick-fill chips (F1).
    await person(page).getByRole('button', { name: 'Female', exact: true }).click();
    await expect(person(page).getByLabel('Gender', { exact: true })).toHaveValue('Female');
    await page.getByLabel('Wearing').fill('TEST-form pink hat, silver fringe top');
    // More details, typed straight in (no tap to open them).
    await more(page).getByLabel('Hair', { exact: true }).fill('TEST-form blonde braids');
    await more(page).getByLabel('Build', { exact: true }).fill('TEST-form 5\'5", slim');
    await more(page).getByLabel('Features', { exact: true }).fill('TEST-form nose ring');
    await more(page).getByLabel('Description', { exact: true }).fill('TEST-form tall, freckles,\nclear bag');
    await more(page).getByLabel('Other notes', { exact: true }).fill('TEST-form lost phone');
    // A chip clicked from another field appends to Last seen and takes the caret there.
    await personName(page).focus();
    await page.getByRole('button', { name: 'kineticFIELD' }).click();
    await expect(lastSeen(page)).toHaveValue('kineticFIELD');
    await expect(lastSeen(page)).toBeFocused();
    await page.keyboard.type(', ~10:30');
    await friend(page).getByLabel('Name').fill('TEST-form Maya R.');
    await friend(page).getByLabel('Phone').fill('(407) 555-0142');
    await expect(page.getByRole('img', { name: 'Valid number' })).toBeVisible();
    await friend(page).getByLabel('Relation').fill('TEST-form sister');
    await friend(page).getByLabel('Notes').fill('TEST-form waiting at the ferris wheel');
    await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: syntheticPng() });
    await confirmCrop(page);
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
      age: 'mid-20s',
      gender: 'Female',
      clothing: 'TEST-form pink hat, silver fringe top',
      lastSeen: 'kineticFIELD, ~10:30',
      hair: 'TEST-form blonde braids',
      heightBuild: 'TEST-form 5\'5", slim',
      identifyingFeatures: 'TEST-form nose ring',
      physicalDescription: 'TEST-form tall, freckles,\nclear bag',
      additionalNotes: 'TEST-form lost phone',
      contactName: 'TEST-form Maya R.',
      contactPhone: '(407) 555-0142',
      contactRelationship: 'TEST-form sister',
      contactNotes: 'TEST-form waiting at the ferris wheel',
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

  test('opened from the app, a double Esc steps back once, to the page it was opened from', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html[data-hydrated="true"]')).toHaveCount(1);
    // What the shell's New request button does (lib/client/nav navigate: a fresh state, one entry deeper).
    await page.evaluate(() => window.history.pushState({ lpDepth: 1 }, '', '/?new=1'));
    await expect(modal(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(form(page)).toHaveCount(0);
    await page.waitForTimeout(400);
    const url = new URL(page.url());
    expect(url.origin + url.pathname + url.search).toBe(`${ORIGIN}/`);
  });

  test('the photo manager drops beside the slot; removing the last photo closes it', async ({ page }) => {
    await openNew(page);
    await page.locator('input[type=file]').setInputFiles([
      { name: 'a.png', mimeType: 'image/png', buffer: syntheticPng() },
      { name: 'b.png', mimeType: 'image/png', buffer: syntheticPng(100, 140) },
    ]);
    await confirmCrops(page, 2);
    const slot = page.getByRole('button', { name: /^2 photos, today/ });
    await expect(slot).toBeVisible();
    await slot.click();
    const photos = page.getByRole('dialog', { name: 'Photos' });
    await expect(photos).toBeVisible();
    // Beside the slot, inside the window (not a sheet rising from the bottom of the screen).
    const slotBox = await box(page, slot);
    const popBox = await box(page, photos);
    expect(popBox.x).toBeGreaterThanOrEqual(slotBox.x + slotBox.width);
    expect(popBox.y + popBox.height).toBeLessThanOrEqual(900);

    await photos.getByRole('radio', { name: 'Not today' }).click();
    await expect(page.getByRole('button', { name: /^2 photos, not today/ })).toBeVisible();
    await photos.getByRole('button', { name: 'Remove photo 2' }).click();
    await photos.getByRole('button', { name: 'Remove photo 1' }).click();
    await expect(photos).toBeHidden();
    await expect(page.getByRole('button', { name: 'Add photo' })).toBeVisible();
    await expect(modal(page)).toBeVisible();
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

  test('edit of the person is one column: the person, then More details open under it; nothing else', async ({ page }) => {
    const name = uniqueName('edit-person');
    const row = await apiCreate(page.request, { name, age: 'early 20s', hair: 'TEST-form red bob', contactName: 'TEST-form Jo' });
    const title = `Edit LP-${String(row.caseNumber).padStart(4, '0')}`;
    await page.goto(`/?r=${row.id}&edit=person`);
    await expect(modal(page, title)).toBeVisible();
    expect(Math.round((await box(page, modal(page, title))).width)).toBe(520);
    await expect(friend(page)).toHaveCount(0);
    expect(await fieldOrder(page)).toEqual([...PERSON_FIELDS, ...MORE_FIELDS]);
    const top = await box(page, person(page));
    const below = await box(page, more(page));
    expect(below.y).toBeGreaterThan(top.y + top.height);
    expect(Math.abs(below.x - top.x)).toBeLessThanOrEqual(1);
    await expect(person(page).getByLabel('Age', { exact: true })).toHaveValue('early 20s');
    await expect(more(page).getByLabel('Hair', { exact: true })).toHaveValue('TEST-form red bob');

    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/requests/${row.id}`));
    await more(page).getByLabel('Features', { exact: true }).fill('TEST-form glitter on cheeks');
    await page.keyboard.press('ControlOrMeta+Enter');
    expect((await patch).postDataJSON()).toEqual({ patch: { identifyingFeatures: 'TEST-form glitter on cheeks' }, expectedVersion: row.rowVersion });
    await expect(form(page)).toHaveCount(0);
  });

  // (Phase 3) On a cold load the edit waits for the first sync behind a frame with the same title (A10); on a stack
  // with a lot of data that sync is slow. The form used to mount a second dialog when it came, which opened again
  // (overlay fade, content scale-in) under the user and under the layout checks above (511-518 px wide mid-animation).
  test('edit on a cold load with a slow first sync: the dialog opens once; the form takes the frame\'s place', async ({ page }) => {
    const name = uniqueName('edit-slow-sync');
    const row = await apiCreate(page.request, { name, contactName: 'TEST-form Jo', contactPhone: '407 555 0100' });
    await page.route('**/api/sync**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.continue().catch(() => undefined);
    });
    await page.addInitScript(() => {
      const w = window as unknown as { __opens: string[] };
      w.__opens = [];
      document.addEventListener(
        'animationstart',
        (e) => {
          const t = e.target as Element;
          if (t.classList.contains('lp-rf-dlg')) w.__opens.push('content');
          else if (t.classList.contains('rt-BaseDialogOverlay')) w.__opens.push('overlay');
        },
        true,
      );
    });
    const title = `Edit LP-${String(row.caseNumber).padStart(4, '0')}`;
    await page.goto(`/?r=${row.id}&edit=friend`);
    await expect(modal(page, title)).toBeVisible();
    await expect(friend(page).getByLabel('Phone')).toHaveValue('407 555 0100', { timeout: 20_000 });
    expect(Math.round((await box(page, modal(page, title))).width)).toBe(520);
    const opens = await page.evaluate(() => (window as unknown as { __opens: string[] }).__opens);
    expect(opens.filter((n) => n === 'content')).toHaveLength(1);
    expect(opens.filter((n) => n === 'overlay')).toHaveLength(1);
    // And it edits as always.
    await friend(page).getByLabel('Phone').fill('407 555 0199');
    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/requests/${row.id}`));
    await page.keyboard.press('ControlOrMeta+Enter');
    expect((await patch).postDataJSON()).toEqual({ patch: { contactPhone: '407 555 0199' }, expectedVersion: row.rowVersion });
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
          // Every group is open (F1): More details is on screen without a tap.
          await expect(page.getByRole('group', { name: 'More details' })).toBeVisible();
          await settle(page);
          expect(await axeViolations(page)).toEqual([]);
          expect(await overlappingTargets(page, '[data-testid="request-form"]')).toEqual([]);
          if (size.hasTouch) expect(await smallTargets(page, '[data-testid="request-form"]')).toEqual([]);

          await postChip(page).click();
          await expect(page.getByRole('dialog', { name: 'Reporting from' })).toBeVisible();
          await settle(page);
          expect(await axeViolations(page)).toEqual([]);
          if (size.hasTouch) expect(await smallTargets(page, '.lp-rf-pop')).toEqual([]);
          await page.keyboard.press('Escape');

          await page.locator('input[type=file]').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: syntheticPng() });
          await confirmCrop(page);
          await page.getByRole('button', { name: /^1 photo, today/ }).click();
          await expect(page.getByRole('dialog', { name: 'Photos' })).toBeVisible();
          await settle(page);
          expect(await axeViolations(page)).toEqual([]);
          expect(await overlappingTargets(page, '.lp-rf-photos')).toEqual([]);
          if (size.hasTouch) expect(await smallTargets(page, '.lp-rf-photos')).toEqual([]);
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
    // One column in Jeffrey's order: Missing person, More details, Friend or family.
    expect(await fieldOrder(page)).toEqual([...PERSON_FIELDS, ...MORE_FIELDS, ...FRIEND_FIELDS]);
    const top = await box(page, person(page));
    const middle = await box(page, more(page));
    const below = await box(page, friend(page));
    expect(middle.y).toBeGreaterThan(top.y + top.height - 1);
    expect(below.y).toBeGreaterThan(middle.y + middle.height - 1);
    expect(Math.abs(middle.x - top.x)).toBeLessThanOrEqual(1);
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

  test('too tall for 820 px: the body scrolls between the pinned header and footer', async ({ page }) => {
    await openNew(page);
    const frame = await box(page, modal(page));
    expect(frame.y + frame.height).toBeLessThanOrEqual(820);
    expect(await scroller(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    const title = page.getByRole('heading', { name: 'New request' });
    const titleAt = await box(page, title);
    const sendAt = await box(page, submit(page));

    // The last More details field, typed into from the keyboard, scrolls into view above the footer.
    await more(page).getByLabel('Other notes', { exact: true }).focus();
    await page.keyboard.type('TEST-form scrolled');
    await scroller(page).evaluate((el) => el.scrollTo(0, el.scrollHeight));
    expect(await scroller(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const notes = await box(page, more(page).getByLabel('Other notes', { exact: true }));
    const body = await box(page, scroller(page));
    expect(notes.y + notes.height).toBeLessThanOrEqual(body.y + body.height + 0.5);
    expect(await box(page, title)).toEqual(titleAt);
    expect(await box(page, submit(page))).toEqual(sendAt);
    expect(sendAt.y + sendAt.height).toBeLessThanOrEqual(frame.y + frame.height);
  });
});

// ---- Crossing 768 px: the form keeps what is typed --------------------------------------------------

test.describe('crossing 768 px (iPad mini rotated, a window snapped to half a screen)', () => {
  test.use({ viewport: { width: 1133, height: 744 }, isMobile: false, hasTouch: true });

  test('unsaved Edit details survive the modal turning into the phone page and back; Save sends them', async ({ page }) => {
    const name = uniqueName('rotate');
    const row = await apiCreate(page.request, { name, clothing: 'TEST-form black tee', contactName: 'TEST-form Jo' });
    const title = `Edit LP-${String(row.caseNumber).padStart(4, '0')}`;
    const wearing = () => form(page).getByLabel('Wearing', { exact: true });
    await page.goto(`/?r=${row.id}&edit=all`);
    await expect(modal(page, title)).toBeVisible();
    await wearing().fill('TEST-form EDITED rotation');

    // Portrait: 744 px wide, the phone's full-screen page with the edit still in it.
    await page.setViewportSize({ width: 744, height: 1133 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(form(page)).toBeVisible();
    await expect(wearing()).toHaveValue('TEST-form EDITED rotation');
    await expect(submit(page)).toBeEnabled();

    // Back to landscape: the modal again, still edited.
    await page.setViewportSize({ width: 1133, height: 744 });
    await expect(modal(page, title)).toBeVisible();
    await expect(wearing()).toHaveValue('TEST-form EDITED rotation');

    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/requests/${row.id}`));
    await submit(page).click();
    expect((await patch).postDataJSON()).toEqual({ patch: { clothing: 'TEST-form EDITED rotation' }, expectedVersion: row.rowVersion });
    await expect(form(page)).toHaveCount(0);
    expect(await apiDetail(page.request, row.id)).toMatchObject({ clothing: 'TEST-form EDITED rotation' });
  });

  test('a new request keeps its fields across the switch too', async ({ page }) => {
    await page.setViewportSize({ width: 744, height: 1133 });
    await page.goto('/?new=1');
    await expect(form(page)).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const name = uniqueName('rotate-new');
    await personName(page).fill(name);
    await page.setViewportSize({ width: 1133, height: 744 });
    await expect(modal(page)).toBeVisible();
    await expect(personName(page)).toHaveValue(name);
    await page.setViewportSize({ width: 744, height: 1133 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(personName(page)).toHaveValue(name);
    // Discard, so no draft is left for the next test.
    await page.getByRole('button', { name: 'Cancel' }).first().click();
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(form(page)).toHaveCount(0);
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
