import { deflateSync } from 'node:zlib';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { testBaseUrl } from '../../scripts/test-env.mjs';
import { addSessionCookie } from './helpers/session';

// New request / Edit / Needs-attention editor (spec §8 New request, §9.4, v2.1 A10/A13/A20/A33).
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
const friend = (page: Page) => page.getByRole('group', { name: 'Friend or family' });
const personName = (page: Page) => person(page).getByLabel('Name', { exact: true });
const lastSeen = (page: Page) => page.getByRole('textbox', { name: 'Last seen' });

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
  const res = await request.get('/api/sync');
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { rows: Row[] };
  return body.rows.filter((r) => r.name === name);
}

// ---- Setup ----------------------------------------------------------------------------------------

let errors: string[];

test.beforeEach(async ({ context, page }) => {
  await addSessionCookie(context, STAFF);
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text());
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
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
  await openNew(page);
  await expect(page.getByRole('button', { name: 'Reporting from TEST-F gate 9. Change' })).toBeVisible();
});

test('creates a request with a photo; it shows in All and My requests', async ({ page }) => {
  const name = uniqueName('Kayla');
  await openNew(page);
  await pickPost(page, 'FA 4 – Oasis');
  await personName(page).fill(name);
  await person(page).getByLabel('Age', { exact: true }).fill('19');
  await page.getByRole('radio', { name: 'Female', exact: true }).click();
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

  await submit(page).click();
  await expect(page.getByText(/^LP-\d{4,} saved$/)).toBeVisible();
  await expect(form(page)).toHaveCount(0);
  await expect(page.getByText(name).first()).toBeVisible();

  // Exactly one row, with every field and the photo (uploaded after the create).
  await expect.poll(async () => (await rowsNamed(page.request, name)).length).toBe(1);
  const [created] = await rowsNamed(page.request, name);
  expect(created).toMatchObject({
    reportingLocation: 'FA 4 – Oasis',
    age: 19,
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

  await page.getByRole('button', { name: 'Cancel' }).click();
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
  await expect(page.getByRole('group', { name: 'Missing person' })).toHaveCount(0);
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

  await page.getByRole('button', { name: 'More details' }).click();
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
  await expect(page.getByText('Saved on this phone · sends when back online')).toBeVisible();
  await expect(form(page)).toHaveCount(0);

  await context.setOffline(false);
  await expect.poll(async () => (await rowsNamed(page.request, name)).length, { timeout: 30_000 }).toBe(1);
  const [sent] = await rowsNamed(page.request, name);
  await expect.poll(async () => (await apiDetail(page.request, sent!.id)).photos.length, { timeout: 30_000 }).toBe(1);
});
