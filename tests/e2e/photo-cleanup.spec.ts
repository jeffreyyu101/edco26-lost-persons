import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { axeViolations, smallTargets } from './helpers/a11y';
import { jpegInfo, screenPhotoJpeg } from './helpers/photo';
import { signedInAs } from './helpers/session';
import { syncRows } from './helpers/sync';

// Photos of a phone screen (design/DECISIONS.md v2.2 #10; Jeffrey, 2026-11-06 15:13). A 12 MP synthetic
// "photo of a friend's phone" with EXIF (camera, Orientation 6, GPS) is picked in New request, the bezel is
// cut away in the crop step by dragging two corners, and the request is sent. The stored photo must be
// smaller than the picked file, carry no EXIF, be upright (portrait), and have the crop's shape. The
// keyboard path (Tab, arrows, Enter; Escape keeps the whole photo) and axe run on the crop step.
// Synthetic data only: every request is named TEST-P-<run>-<n>.

const RUN = Date.now().toString(36);
let seq = 0;
const uniqueName = (label: string) => `TEST-P-${RUN}-${(seq += 1)} ${label}`;
const STAFF = { staffName: `TEST-P Photo ${RUN}`, team: 'GC/HX - Dispatch' };

signedInAs(STAFF);

interface Row {
  id: string;
  name: string;
}

const submit = (page: Page) => page.getByTestId('request-form-submit');
const cropStep = (page: Page) => page.getByRole('dialog', { name: 'Crop photo' });
const personName = (page: Page) => page.getByRole('group', { name: 'Missing person' }).getByLabel('Name', { exact: true });

async function openNew(page: Page) {
  await page.goto('/?new=1');
  await expect(submit(page)).toBeVisible();
}

async function pickPost(page: Page, post: string) {
  await page.getByRole('button', { name: /^Reporting from/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Reporting from' });
  await sheet.locator('label', { hasText: post }).click();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();
}

async function photoIds(request: APIRequestContext, id: string): Promise<string[]> {
  const res = await request.get(`/api/requests/${id}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { photos: Array<{ id: string }> }).photos.map((p) => p.id);
}

/** Waits for the crop step's slide-in (and any other animation) to finish, so boxes are final. */
async function settled(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
}

/** Drags from one page point to another with the mouse (pointer events; the crop step treats touch the same). */
async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

test('a photo of a phone screen: crop the bezel, send; the stored photo is smaller, upright, cropped and has no EXIF', async ({ page }) => {
  test.setTimeout(120_000);
  const name = uniqueName('screen');
  await openNew(page);
  const fixture = await screenPhotoJpeg(page);
  const input = jpegInfo(fixture.jpeg);
  expect(input.hasExif).toBe(true);
  // Stored landscape; Orientation 6 shows it portrait.
  expect([input.width, input.height]).toEqual([fixture.height, fixture.width]);

  await pickPost(page, 'FA 4 – Oasis');
  await personName(page).fill(name);
  await page.locator('input[type=file]').setInputFiles({ name: 'screen.jpg', mimeType: 'image/jpeg', buffer: fixture.jpeg });

  const step = cropStep(page);
  await expect(step).toBeVisible();
  await expect(step.getByRole('button', { name: 'Use photo' })).toBeFocused();
  const frame = step.getByTestId('crop-frame');
  await expect(frame).toHaveAttribute('data-ready', '');
  await settled(page);
  const box = (await frame.boundingBox())!;
  // The preview is upright (portrait), like the photo.
  expect(box.height).toBeGreaterThan(box.width);
  const sel = step.locator('[data-selection]');
  await expect(sel).toHaveAccessibleName('Crop area, whole photo');

  // Drag the top-left and bottom-right corners onto the phone's screen. Each corner point is 10 px in
  // from its 44 px target's outer edge.
  const s = fixture.screen;
  const nw = (await step.getByRole('button', { name: 'Top left corner' }).boundingBox())!;
  await dragTo(page, { x: nw.x + 10, y: nw.y + 10 }, { x: box.x + s.x * box.width, y: box.y + s.y * box.height });
  const se = (await step.getByRole('button', { name: 'Bottom right corner' }).boundingBox())!;
  await dragTo(page, { x: se.x + 34, y: se.y + 34 }, { x: box.x + (s.x + s.width) * box.width, y: box.y + (s.y + s.height) * box.height });
  const w = Math.round(s.width * 100);
  const h = Math.round(s.height * 100);
  await expect(sel).toHaveAccessibleName(new RegExp(`^Cropped to (${w - 1}|${w}|${w + 1}) by (${h - 1}|${h}|${h + 1}) percent`));
  await expect(step.getByRole('button', { name: 'Reset to the whole photo' })).toBeVisible();

  await step.getByRole('button', { name: 'Use photo' }).click();
  await expect(step).toBeHidden();
  await expect(page.getByRole('button', { name: /^1 photo, today/ })).toBeVisible({ timeout: 15_000 });

  const prepared = await page.evaluate(() => {
    const e = performance.getEntriesByName('lp-photo-prepare').at(-1) as PerformanceMeasure | undefined;
    return e ? { ms: Math.round(e.duration), ...(e.detail as Record<string, unknown>) } : null;
  });
  expect(prepared).not.toBeNull();
  test.info().annotations.push({ type: 'prepare', description: JSON.stringify(prepared) });

  await submit(page).click();
  await expect(page.getByText(/^LP-\d{4,} saved$/)).toBeVisible();
  await expect.poll(async () => (await syncRows<Row>(page.request)).filter((r) => r.name === name).length).toBe(1);
  const [row] = (await syncRows<Row>(page.request)).filter((r) => r.name === name);
  await expect.poll(async () => (await photoIds(page.request, row!.id)).length, { timeout: 30_000 }).toBe(1);
  const [photoId] = await photoIds(page.request, row!.id);

  for (const size of ['full', 'thumb'] as const) {
    const res = await page.request.get(`/api/photos/${photoId}?size=${size}`);
    expect(res.ok(), `${size} → ${res.status()}`).toBe(true);
    const stored = jpegInfo(await res.body());
    test.info().annotations.push({ type: `stored-${size}`, description: JSON.stringify(stored) });
    expect(stored.isJpeg).toBe(true);
    expect(stored.hasExif).toBe(false);
    expect(stored.bytes).toBeLessThan(input.bytes);
    // Upright, within the size limits, and the shape of the crop (the phone's screen).
    expect(stored.height).toBeGreaterThan(stored.width);
    expect(Math.max(stored.width, stored.height)).toBeLessThanOrEqual(size === 'full' ? 1600 : 320);
    const want = (s.width * fixture.width) / (s.height * fixture.height);
    expect(Math.abs(stored.width / stored.height - want)).toBeLessThan(0.04);
  }
  const full = jpegInfo(await (await page.request.get(`/api/photos/${photoId}?size=full`)).body());
  expect(full.height).toBe(1600);
});

test('keyboard: arrows move a corner, Enter uses the photo; Escape keeps the whole photo', async ({ page }) => {
  test.setTimeout(90_000);
  await openNew(page);
  const fixture = await screenPhotoJpeg(page, { width: 900, height: 1200 });
  await page.locator('input[type=file]').setInputFiles({ name: 'screen.jpg', mimeType: 'image/jpeg', buffer: fixture.jpeg });
  const step = cropStep(page);
  await expect(step.getByTestId('crop-frame')).toHaveAttribute('data-ready', '');
  await step.getByRole('button', { name: 'Top left corner' }).focus();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(step.locator('[data-selection]')).toHaveAccessibleName('Cropped to 95 by 94 percent of the photo');
  await page.keyboard.press('Enter');
  await expect(step).toBeHidden();
  await expect(page.getByRole('button', { name: /^1 photo/ })).toBeVisible({ timeout: 15_000 });
  const first = await page.evaluate(() => (performance.getEntriesByName('lp-photo-prepare').at(-1) as PerformanceMeasure).detail as { cropped: boolean; height: number });
  expect(first.cropped).toBe(true);

  // A second photo through the manager's Add tile; Escape skips the crop.
  await page.getByRole('button', { name: /^1 photo/ }).click();
  const manager = page.getByRole('dialog', { name: 'Photos' });
  await expect(manager).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ name: 'screen-2.jpg', mimeType: 'image/jpeg', buffer: fixture.jpeg });
  await expect(step).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(step).toBeHidden();
  await expect(manager.getByRole('img', { name: 'Photo 2 of 2' })).toBeVisible({ timeout: 15_000 });
  const second = await page.evaluate(() => (performance.getEntriesByName('lp-photo-prepare').at(-1) as PerformanceMeasure).detail as { cropped: boolean });
  expect(second.cropped).toBe(false);
});

test('Retake drops the photo and opens the picker again', async ({ page }) => {
  await openNew(page);
  // Landscape this time: the photo fits the width of the sheet.
  const fixture = await screenPhotoJpeg(page, { width: 1200, height: 800 });
  await page.locator('input[type=file]').setInputFiles({ name: 'screen.jpg', mimeType: 'image/jpeg', buffer: fixture.jpeg });
  const step = cropStep(page);
  await expect(step.getByTestId('crop-frame')).toHaveAttribute('data-ready', '');
  await settled(page);
  const frame = (await step.getByTestId('crop-frame').boundingBox())!;
  const sheet = (await step.boundingBox())!;
  expect(frame.width).toBeGreaterThan(frame.height);
  expect(frame.x).toBeGreaterThanOrEqual(sheet.x + 16);
  expect(frame.x + frame.width).toBeLessThanOrEqual(sheet.x + sheet.width - 16);
  const chooser = page.waitForEvent('filechooser');
  await step.getByRole('button', { name: 'Retake' }).click();
  const picker = await chooser;
  await expect(step).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add photo' })).toBeVisible();
  await picker.setFiles({ name: 'again.jpg', mimeType: 'image/jpeg', buffer: fixture.jpeg });
  await expect(step).toBeVisible();
  await step.getByRole('button', { name: 'Use photo' }).click();
  await expect(page.getByRole('button', { name: /^1 photo/ })).toBeVisible({ timeout: 15_000 });
});

test.describe('accessibility', () => {
  test.use({ bypassCSP: true, serviceWorkers: 'block' });

  test('the crop step passes axe, and every control is at least 44 px', async ({ page }) => {
    await openNew(page);
    const fixture = await screenPhotoJpeg(page, { width: 900, height: 1200 });
    await page.locator('input[type=file]').setInputFiles({ name: 'screen.jpg', mimeType: 'image/jpeg', buffer: fixture.jpeg });
    const step = cropStep(page);
    await expect(step.getByTestId('crop-frame')).toHaveAttribute('data-ready', '');
    await step.getByRole('button', { name: 'Top left corner' }).focus();
    await page.keyboard.press('Shift+ArrowRight');
    await settled(page);
    expect(await axeViolations(page)).toEqual([]);
    expect((await smallTargets(page, '[role="dialog"]')).map((t) => `${t.name} ${t.width}×${t.height}`)).toEqual([]);
  });
});
