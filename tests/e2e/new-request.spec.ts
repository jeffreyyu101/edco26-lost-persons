import { deflateSync } from 'node:zlib';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { signedInAs } from './helpers/session';
import { syncRows } from './helpers/sync';

// New request / Edit / Needs-attention editor (spec §8 New request, §9.4, v2.1 A10/A13/A20/A33), with
// Jeffrey's 2026-11-06 changes: every group open in the order post → missing person → more details →
// friend or family (optional, last), and free-text age ("mid-20s") and gender (typed or a quick-fill chip).
// Runs at integration against the real store and API (`npm run build:test`, then `npm run test:e2e`).
// Synthetic data only: every request is named TEST-F-<run>-<n>. Offline here means
// context.setOffline() on an already loaded page (no service-worker reload; that gate lives in the
// offline / SW specs run in Merge 2 and QA, A17).

const RUN = Date.now().toString(36);
let seq = 0;
const uniqueName = (label: string) => `TEST-F-${RUN}-${(seq += 1)} ${label}`;
const STAFF = { staffName: `TEST-F Form ${RUN}`, team: 'GC/HX - Dispatch' };
const ORIGIN = new URL(testBaseUrl()).origin;

/** A small, decodable synthetic PNG (a two-colour gradient), so the store's canvas compression runs. */
function syntheticPng(width = 120, height = 160): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const t = y / height;
      raw[row + 1 + x * 3] = Math.round(230 * (1 - t) + 40 * t);
      raw[row + 2 + x * 3] = Math.round(120 * (1 - t) + 40 * t);
      raw[row + 3 + x * 3] = Math.round(170 * (1 - t) + 60 * t);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- Locators -------------------------------------------------------------------------------------

const form = (page: Page) => page.getByTestId('request-form');
const submit = (page: Page) => page.getByTestId('request-form-submit');
const person = (page: Page) => page.getByRole('group', { name: 'Missing person' });
const more = (page: Page) => page.getByRole('group', { name: 'More details' });
const friend = (page: Page) => page.getByRole('group', { name: 'Friend or family' });
const personName = (page: Page) => person(page).getByLabel('Name', { exact: true });
const age = (page: Page) => person(page).getByLabel('Age', { exact: true });
const gender = (page: Page) => person(page).getByLabel('Gender', { exact: true });
const genderChip = (page: Page, chip: string) => person(page).getByRole('button', { name: chip, exact: true });
const lastSeen = (page: Page) => page.getByRole('textbox', { name: 'Last seen' });

/** Top and bottom of an element in page pixels. */
async function edges(locator: Locator): Promise<{ top: number; bottom: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('not rendered');
  return { top: box.y, bottom: box.y + box.height };
}

/**
 * A stand-in for the on-screen keyboard: Playwright shows none, so window.visualViewport is replaced by a
 * fake whose height `setKeyboard(page, px)` shrinks, firing `resize` as a phone does when the keyboard opens.
 */
async function fakeKeyboard(page: Page) {
  await page.addInitScript(() => {
    const vv = Object.assign(new EventTarget(), {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    Object.assign(window, {
      __lpKeyboard: (px: number) => {
        vv.height = window.innerHeight - px;
        vv.dispatchEvent(new Event('resize'));
      },
    });
  });
}
const setKeyboard = (page: Page, px: number) =>
  page.evaluate((h) => (window as unknown as { __lpKeyboard: (px: number) => void }).__lpKeyboard(h), px);

async function openNew(page: Page) {
  await page.goto('/?new=1');
  await expect(submit(page)).toBeVisible();
}

async function pickPost(page: Page, post: string, where?: string) {
  await page.getByRole('button', { name: /^Reporting from/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Reporting from' });
  await sheet.locator('label', { hasText: post }).click();
  if (where) await sheet.getByLabel('Other location').fill(where);
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();
}

// ---- API helpers (the same session as the page) -----------------------------------------------------

interface Row {
  id: string;
  name: string;
  rowVersion: number;
  clientMutationId: string | null;
  caseNumber: number;
  [key: string]: unknown;
}

async function apiCreate(request: APIRequestContext, body: Record<string, unknown>): Promise<Row> {
  const res = await request.post('/api/requests', {
    headers: { Origin: ORIGIN },
    data: { clientMutationId: crypto.randomUUID(), reportingLocation: 'FA 3 – Kinetic', ...body },
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { request: Row }).request;
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

const NETWORK_FAILURE = /^(Failed to load resource|Cannot load http|FetchEvent\.respondWith received an error: TypeError: Load failed)/;
let errors: string[];

// Signed in once through POST /api/session (A17).
signedInAs(STAFF);

test.beforeEach(async ({ page }) => {
  errors = [];
  // WebKit also reports a chunk fetch the offline worker couldn't serve as a page error.
  page.on('pageerror', (e) => {
    const text = String(e);
    if (!NETWORK_FAILURE.test(text) && !NETWORK_FAILURE.test(e.message)) errors.push(text);
  });
  page.on('console', (msg) => {
    // Network failures (expected while offline: the idle prefetch of other view chunks) are not app errors:
    // Chromium logs "Failed to load resource", WebKit "Cannot load …" and the worker's "Load failed".
    if (msg.type() === 'error' && !NETWORK_FAILURE.test(msg.text())) errors.push(msg.text());
  });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

// ---- Specs ----------------------------------------------------------------------------------------

test('Send needs a post and a detail; a photo counts; Other asks where', async ({ page }) => {
  await openNew(page);
  // A new phone has no remembered post.
  await expect(page.getByText('Choose post')).toBeVisible();
  await expect(submit(page)).toBeDisabled();
  await personName(page).fill(uniqueName('needs post'));
  await expect(submit(page)).toBeDisabled();

  await page.getByRole('button', { name: /^Reporting from/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Reporting from' });
  await sheet.locator('label', { hasText: 'Other' }).click();
  await expect(sheet.getByRole('button', { name: 'Done' })).toBeDisabled();
  await sheet.getByLabel('Other location').fill('TEST-F gate 9');
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: 'Reporting from TEST-F gate 9. Change' })).toBeVisible();
  await expect(submit(page)).toBeEnabled();

  // Clearing the only detail disables Send again; a photo alone re-enables it.
  await personName(page).fill('');
  await expect(submit(page)).toBeDisabled();
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: syntheticPng() });
  await expect(page.getByRole('button', { name: /^1 photo/ })).toBeVisible();
  await expect(submit(page)).toBeEnabled();

  // The post is remembered for the next request.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
  await openNew(page);
  await expect(page.getByRole('button', { name: 'Reporting from TEST-F gate 9. Change' })).toBeVisible();
});

test('creates a request with a photo; it shows in All and My requests', async ({ page }) => {
  const name = uniqueName('Kayla');
  await openNew(page);
  await pickPost(page, 'FA 4 – Oasis');
  await personName(page).fill(name);
  await age(page).fill('mid-20s');
  await genderChip(page, 'Female').click();
  await expect(gender(page)).toHaveValue('Female');
  await expect(genderChip(page, 'Female')).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Wearing').fill('Pink cowboy hat, silver fringe top');

  // Stage chips show while Last seen has focus; a tap appends with ", " and keeps focus.
  await expect(page.getByRole('button', { name: 'kineticFIELD' })).toHaveCount(0);
  await lastSeen(page).fill('rail, ~10:30');
  await expect(page.getByRole('button', { name: 'kineticFIELD' })).toBeVisible();
  await page.getByRole('button', { name: 'kineticFIELD' }).click();
  await expect(lastSeen(page)).toHaveValue('rail, ~10:30, kineticFIELD');
  await expect(lastSeen(page)).toBeFocused();

  await friend(page).getByLabel('Name').fill('TEST-F Maya R.');
  await friend(page).getByLabel('Phone').fill('(407) 555-0142');
  await expect(page.getByRole('img', { name: 'Valid number' })).toBeVisible();
  await friend(page).getByLabel('Relation').fill('Best friend');
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: syntheticPng() });
  await expect(page.getByRole('button', { name: /^1 photo, today/ })).toBeVisible();

  await expect(submit(page)).toBeEnabled();
  await submit(page).click();
  await expect(page.getByText(/^LP-\d{4,} saved$/)).toBeVisible();
  await expect(form(page)).toHaveCount(0);
  await expect(page.getByText(name).first()).toBeVisible();

  // Exactly one row, with every field and the photo (uploaded after the create).
  await expect.poll(async () => (await rowsNamed(page.request, name)).length).toBe(1);
  const [created] = await rowsNamed(page.request, name);
  expect(created).toMatchObject({
    reportingLocation: 'FA 4 – Oasis',
    age: 'mid-20s',
    gender: 'Female',
    clothing: 'Pink cowboy hat, silver fringe top',
    lastSeen: 'rail, ~10:30, kineticFIELD',
    contactName: 'TEST-F Maya R.',
    contactPhone: '(407) 555-0142',
    contactRelationship: 'Best friend',
  });
  await expect.poll(async () => (await apiDetail(page.request, created!.id)).photos.length, { timeout: 20_000 }).toBe(1);

  await page.goto('/?view=mine');
  await expect(page.getByText(name).first()).toBeVisible();
});

test('age, gender and phone take any text; a gender chip fills Gender, a second tap clears it', async ({ page }) => {
  const name = uniqueName('free text');
  await openNew(page);
  await pickPost(page, 'Base');
  await personName(page).fill(name);
  await age(page).fill('early 30s');
  await expect(age(page)).toHaveValue('early 30s');
  await expect(age(page)).not.toHaveAttribute('inputmode', /.+/);

  await genderChip(page, 'Other').click();
  await expect(gender(page)).toHaveValue('Other');
  await expect(genderChip(page, 'Other')).toHaveAttribute('aria-pressed', 'true');
  await genderChip(page, 'Other').click();
  await expect(gender(page)).toHaveValue('');
  await gender(page).fill('Non-binary');
  for (const chip of ['Male', 'Female', 'Other']) await expect(genderChip(page, chip)).toHaveAttribute('aria-pressed', 'false');

  // Any phone text is kept; only a 10–15 digit number gets the check.
  await friend(page).getByLabel('Phone').fill('555-0142 ext 2');
  await expect(page.getByRole('img', { name: 'Valid number' })).toHaveCount(0);
  await expect(submit(page)).toBeEnabled();

  const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/requests'));
  await submit(page).click();
  expect((await post).postDataJSON()).toMatchObject({ age: 'early 30s', gender: 'Non-binary', contactPhone: '555-0142 ext 2' });
  await expect(page.getByText(/^LP-\d{4,} saved$/)).toBeVisible();
  await expect.poll(async () => (await rowsNamed(page.request, name)).length).toBe(1);
  const [created] = await rowsNamed(page.request, name);
  expect(created).toMatchObject({ age: 'early 30s', gender: 'Non-binary', contactPhone: '555-0142 ext 2' });

  // Edit shows them as typed; a chip replaces the typed gender, and only that key is sent.
  await page.goto(`/?r=${created!.id}&edit=person`);
  await expect(submit(page)).toBeVisible();
  await expect(age(page)).toHaveValue('early 30s');
  await expect(gender(page)).toHaveValue('Non-binary');
  await genderChip(page, 'Female').click();
  await expect(gender(page)).toHaveValue('Female');
  const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/requests/${created!.id}`));
  await submit(page).click();
  expect((await patch).postDataJSON()).toEqual({ patch: { gender: 'Female' }, expectedVersion: created!.rowVersion });
  await expect(page).toHaveURL(new RegExp(`\\?r=${created!.id}$`));
});

test('every group shows at once, in order, with Friend or family last; Send stays pinned', async ({ page }) => {
  await openNew(page);
  // Nothing to expand.
  await expect(page.getByRole('button', { name: 'More details' })).toHaveCount(0);
  await expect(page.locator('[aria-expanded]')).toHaveCount(0);

  const post = await edges(page.getByRole('button', { name: /^Reporting from/ }));
  const groups = [await edges(person(page)), await edges(more(page)), await edges(friend(page))];
  expect(post.bottom).toBeLessThanOrEqual(groups[0]!.top);
  expect(groups[0]!.bottom).toBeLessThanOrEqual(groups[1]!.top);
  expect(groups[1]!.bottom).toBeLessThanOrEqual(groups[2]!.top);

  // Missing person: photo, name, age, gender, wearing, last seen. More details: the person extras.
  for (const label of ['Name', 'Age', 'Gender', 'Wearing', 'Last seen']) await expect(person(page).getByLabel(label, { exact: true })).toBeVisible();
  await expect(person(page).getByRole('button', { name: 'Add photo' })).toBeVisible();
  for (const label of ['Hair', 'Build', 'Features', 'Description', 'Other notes']) await expect(more(page).getByLabel(label, { exact: true })).toBeVisible();
  for (const label of ['Name', 'Phone', 'Relation', 'Notes']) await expect(friend(page).getByLabel(label, { exact: true })).toBeVisible();
  await expect(page.getByText('Optional', { exact: true })).toBeVisible();

  // Enter walks the fields in that order (Last seen → Hair, Relation → Notes).
  await lastSeen(page).focus();
  await page.keyboard.press('Enter');
  await expect(more(page).getByLabel('Hair', { exact: true })).toBeFocused();
  await friend(page).getByLabel('Relation', { exact: true }).focus();
  await page.keyboard.press('Enter');
  const notes = friend(page).getByLabel('Notes', { exact: true });
  await expect(notes).toBeFocused();

  // The form scrolls to its last field while Send stays on screen.
  await notes.fill('TEST-F call after 11');
  await expect(notes).toBeInViewport();
  await expect(submit(page)).toBeInViewport();
});

test('with the keyboard up, Send sits just above it and the focused row stays in view', async ({ page }) => {
  await fakeKeyboard(page);
  await openNew(page);
  const KEYBOARD = 336; // iPhone 14 portrait
  const visible = page.viewportSize()!.height - KEYBOARD;

  await friend(page).getByLabel('Relation', { exact: true }).focus();
  await setKeyboard(page, KEYBOARD);
  await expect(form(page)).toHaveAttribute('data-kb', '');
  await expect.poll(async () => (await edges(submit(page))).bottom).toBeLessThanOrEqual(visible);
  const row = async (locator: Locator) => {
    const box = await edges(locator);
    const send = await edges(submit(page));
    return box.top >= 0 && box.bottom <= send.top;
  };
  await expect.poll(() => row(friend(page).getByLabel('Relation', { exact: true }))).toBe(true);

  // Another field, high up the form: its row, with the place chips it shows, comes into view.
  await lastSeen(page).focus();
  await expect(page.getByRole('button', { name: 'kineticFIELD' })).toBeVisible();
  await expect.poll(() => row(page.getByRole('group', { name: 'Add a place to Last seen' }))).toBe(true);
  await expect.poll(() => row(lastSeen(page))).toBe(true);

  // Keyboard down: the form fills the screen again.
  await setKeyboard(page, 0);
  await expect(form(page)).not.toHaveAttribute('data-kb');
  await expect.poll(async () => (await edges(submit(page))).bottom).toBeGreaterThan(visible);
});

test('a draft survives a reload, with its photo; Cancel discards it', async ({ page }) => {
  const name = uniqueName('draft');
  await openNew(page);
  await pickPost(page, 'Command');
  await personName(page).fill(name);
  await page.getByLabel('Wearing').fill('TEST-F red hoodie');
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: syntheticPng() });
  await expect(page.getByRole('button', { name: /^1 photo/ })).toBeVisible();
  await page.waitForTimeout(600); // the store debounces draft saves by 300 ms

  await page.reload();
  await expect(personName(page)).toHaveValue(name);
  await expect(page.getByLabel('Wearing')).toHaveValue('TEST-F red hoodie');
  await expect(page.getByRole('button', { name: /^1 photo/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reporting from Command. Change' })).toBeVisible();

  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Discard this request?');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
  await expect(form(page)).toHaveCount(0);
  await openNew(page);
  await expect(personName(page)).toHaveValue('');
  expect(await rowsNamed(page.request, name)).toHaveLength(0);
});

test('duplicate hint links to an open request with the same name', async ({ page }) => {
  const name = uniqueName('dup');
  const existing = await apiCreate(page.request, { name, clothing: 'TEST-F blue' });
  await openNew(page);
  await personName(page).fill(name.toUpperCase());
  const chip = page.getByRole('button', { name: `Similar open request: LP-${String(existing.caseNumber).padStart(4, '0')}` });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page).toHaveURL(new RegExp(`\\?r=${existing.id}$`));
});

test('edit sends only the changed keys with the version editing started from', async ({ page }) => {
  const name = uniqueName('edit');
  const row = await apiCreate(page.request, { name, clothing: 'TEST-F black tee', contactName: 'TEST-F Jo', contactPhone: '407 555 0100' });
  await page.goto(`/?r=${row.id}&edit=friend`);
  await expect(submit(page)).toBeDisabled();
  await expect(person(page)).toHaveCount(0);
  await expect(more(page)).toHaveCount(0);
  await friend(page).getByLabel('Phone').fill('407 555 0199');

  const patchRequest = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/requests/${row.id}`));
  await submit(page).click();
  const sent = (await patchRequest).postDataJSON() as { patch: Record<string, unknown>; expectedVersion: number };
  expect(sent).toEqual({ patch: { contactPhone: '407 555 0199' }, expectedVersion: row.rowVersion });
  await expect(page).toHaveURL(new RegExp(`\\?r=${row.id}$`));

  const detail = await apiDetail(page.request, row.id);
  expect(detail).toMatchObject({ contactPhone: '407 555 0199', contactName: 'TEST-F Jo', clothing: 'TEST-F black tee' });
});

test('a conflict keeps my edits, shows theirs, and saves again without reverting them', async ({ page }) => {
  const name = uniqueName('conflict');
  const row = await apiCreate(page.request, { name, clothing: 'TEST-F white tank', hair: null });
  await page.goto(`/?r=${row.id}&edit=person`);
  await expect(submit(page)).toBeVisible();

  // Someone else changes Wearing after this edit started.
  const other = await page.request.patch(`/api/requests/${row.id}`, {
    headers: { Origin: ORIGIN },
    data: { patch: { clothing: 'TEST-F glitter jacket' }, expectedVersion: row.rowVersion },
  });
  expect(other.ok()).toBe(true);

  // More details is open in Edit too: Hair is there without a tap.
  await page.getByLabel('Hair').fill('TEST-F blond braids');
  await submit(page).click();
  await expect(page.getByText('Someone else just updated this. Your changes are kept below — review and save again.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Their changes' })).toContainText('TEST-F glitter jacket');
  await expect(page.getByLabel('Hair')).toHaveValue('TEST-F blond braids');
  await expect(page.getByLabel('Wearing')).toHaveValue('TEST-F glitter jacket');

  const patchRequest = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/requests/${row.id}`));
  await submit(page).click();
  expect(((await patchRequest).postDataJSON() as { patch: unknown }).patch).toEqual({ hair: 'TEST-F blond braids' });
  await expect(page).toHaveURL(new RegExp(`\\?r=${row.id}$`));
  expect(await apiDetail(page.request, row.id)).toMatchObject({ hair: 'TEST-F blond braids', clothing: 'TEST-F glitter jacket' });
});

// page.route can't see requests that pass through a service worker in WebKit, so this mocked rejection runs
// with the worker blocked (nothing here needs it).
test.describe('mocked rejection', () => {
  test.use({ serviceWorkers: 'block' });

  test('a rejected create opens the needs-attention editor; fix and resend with the same id', async ({ page }) => {
    const name = uniqueName('rejected');
    let rejectedId: string | null = null;
    await page.route('**/api/requests', async (route) => {
      if (route.request().method() !== 'POST' || rejectedId) return route.fallback();
      rejectedId = (route.request().postDataJSON() as { clientMutationId: string }).clientMutationId;
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'invalid', message: 'TEST-F rejected name', field: 'name' } }),
      });
    });
    await openNew(page);
    await pickPost(page, 'Base');
    await personName(page).fill(name);
    await submit(page).click();

    await expect(page).toHaveURL(/\?outbox=[0-9a-f-]{36}$/);
    expect(page.url()).toContain(String(rejectedId));
    await expect(personName(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('TEST-F rejected name')).toBeVisible();
    await expect(submit(page)).toHaveText('Resend');
    await expect(submit(page)).toBeDisabled();

    const fixed = `${name} fixed`;
    await personName(page).fill(fixed);
    await expect(page.getByText('TEST-F rejected name')).toHaveCount(0);
    const resend = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/requests'));
    await submit(page).click();
    expect(((await resend).postDataJSON() as { clientMutationId: string; name: string })).toMatchObject({ clientMutationId: rejectedId, name: fixed });
    await expect.poll(async () => (await rowsNamed(page.request, fixed)).map((r) => r.clientMutationId)).toEqual([rejectedId]);
  });
});

test('offline: Save offline queues the request and it sends once back online', async ({ page, context }) => {
  const name = uniqueName('offline');
  await openNew(page);
  await pickPost(page, 'FA 3 – Kinetic');
  await context.setOffline(true);
  await expect(submit(page)).toHaveText('Save offline');
  await expect(page.getByRole('status').filter({ hasText: /Offline · \d+ waiting to send/ }).first()).toBeVisible();
  await personName(page).fill(name);
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: syntheticPng() });
  await expect(page.getByRole('button', { name: /^1 photo/ })).toBeVisible();
  await submit(page).click();
  await expect(page.getByText('Saved on this phone', { exact: true })).toBeVisible();
  await expect(page.getByText('Sends when back online', { exact: true })).toBeVisible();
  await expect(form(page)).toHaveCount(0);

  await context.setOffline(false);
  await expect.poll(async () => (await rowsNamed(page.request, name)).length, { timeout: 30_000 }).toBe(1);
  const [sent] = await rowsNamed(page.request, name);
  await expect.poll(async () => (await apiDetail(page.request, sent!.id)).photos.length, { timeout: 30_000 }).toBe(1);
});

// Edit concurrency (A10): a change made elsewhere that touches nothing the form holds (a liaison's answer)
// never asks for a review and never makes Save fail. /api/sync is held with page.route to make the
// timing exact, so the worker is blocked (WebKit's page.route can't see requests a worker makes).
test.describe('edit after a status change elsewhere', () => {
  test.use({ serviceWorkers: 'block' });

  async function answerInMedical(request: APIRequestContext, row: Row): Promise<Row> {
    const res = await request.post(`/api/requests/${row.id}/status`, {
      headers: { Origin: ORIGIN },
      data: { status: 'Found – Awaiting Reunion', expectedVersion: row.rowVersion, kind: 'answer' },
    });
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { request: Row }).request;
  }

  function trackPatches(page: Page, id: string): number[] {
    const statuses: number[] = [];
    page.on('response', (res) => {
      if (res.request().method() === 'PATCH' && res.url().endsWith(`/api/requests/${id}`)) statuses.push(res.status());
    });
    return statuses;
  }

  test('a reload into Edit from the cache: the first sync brings an answer, Save still works first time', async ({ page }) => {
    const name = uniqueName('cached edit');
    const row = await apiCreate(page.request, { name, clothing: 'TEST-F grey hoodie' });
    // The phone has this row (at its first version) in its cache.
    await page.goto('/');
    await expect(page.locator(`[data-request-id="${row.id}"]`).first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);

    // Meanwhile the liaison answers In medical (a newer version; no form field changed).
    const answered = await answerInMedical(page.request, row as Row);
    expect(answered.rowVersion).toBeGreaterThan(row.rowVersion);

    // Reload straight into Edit, with the first sync held for longer than Edit waits for it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let synced!: () => void;
    const firstSyncDone = new Promise<void>((resolve) => (synced = resolve));
    let first = true;
    await page.route('**/api/sync**', async (route) => {
      if (!first) return route.fallback();
      first = false;
      await held;
      await route.fallback();
      setTimeout(synced, 300);
    });
    const patches = trackPatches(page, row.id);
    await page.goto(`/?r=${row.id}&edit=person`);
    // While the first sync is pending, Edit waits instead of capturing the cached version…
    await expect(page.getByRole('heading', { name: `Edit LP-${String(row.caseNumber).padStart(4, '0')}` })).toBeVisible();
    await expect(submit(page)).toHaveCount(0);
    // …then opens from the cache after a few seconds, and the held sync arrives after that.
    await expect(submit(page)).toBeVisible({ timeout: 6_000 });
    await expect(page.getByLabel('Wearing')).toHaveValue('TEST-F grey hoodie');
    release();
    await firstSyncDone;
    await expect(page.getByText('Updated by someone else')).toHaveCount(0);

    await page.getByLabel('Wearing').fill('TEST-F grey hoodie, red cap');
    await submit(page).click();
    await expect(page).toHaveURL(new RegExp(`\\?r=${row.id}$`));
    expect(patches).toEqual([200]);
    expect(await apiDetail(page.request, row.id)).toMatchObject({ clothing: 'TEST-F grey hoodie, red cap', status: 'Found – Awaiting Reunion' });
  });

  test('Save right after an answer elsewhere: the 409 is resent once on the new version, no review', async ({ page }) => {
    const name = uniqueName('answer mid-edit');
    const row = await apiCreate(page.request, { name, clothing: 'TEST-F blue scarf' });
    await page.goto(`/?r=${row.id}&edit=person`);
    await expect(submit(page)).toBeVisible();
    // No poll may bring the answer before Save: hold every delta poll from here on (the store's own
    // fetch of one row after a 409, ?ids=, goes through).
    await page.route('**/api/sync**', (route) => (new URL(route.request().url()).searchParams.has('ids') ? route.fallback() : undefined));
    await answerInMedical(page.request, row as Row);

    const patches = trackPatches(page, row.id);
    await page.getByLabel('Wearing').fill('TEST-F blue scarf, white shoes');
    await submit(page).click();
    await expect(page).toHaveURL(new RegExp(`\\?r=${row.id}$`));
    expect(patches).toEqual([409, 200]);
    await expect(page.getByText('Someone else just updated this')).toHaveCount(0);
    expect(await apiDetail(page.request, row.id)).toMatchObject({ clothing: 'TEST-F blue scarf, white shoes', status: 'Found – Awaiting Reunion' });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
});
