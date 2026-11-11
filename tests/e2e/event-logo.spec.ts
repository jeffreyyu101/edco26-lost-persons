import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import './helpers/api-event';
import type { EventAdmin } from '@/lib/api-types';
import { BASE, endAll, endEvent, joinToken, lead, makeEvent, signInContext, type TestEvent } from './helpers/events';
import { rgbaPng } from './helpers/png';

// (Events, phase 3) The event logo end to end: a lead uploads it on Event setup; it shows beside Ground Control on the
// join-link sign-in, in the desk sidebar's lockup and on the Ended screen. A single-colour logo on a transparent
// background gets the tint (ink on the sign-in page, white in the lockup, with the rainbow hover layer); any other
// logo is shown as uploaded. A file over 1 MB or one that is not a PNG, WebP or JPEG is refused next to the field and
// the logo stays as it was. Synthetic images only. Runs in both browsers.

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

const RUN = Date.now().toString(36);
const DESK = { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false };

/** A white "T" on a transparent square: single colour, mostly transparent. */
const MONO = rgbaPng(96, 96, (x, y) => ((y >= 12 && y < 28 && x >= 12 && x < 84) || (x >= 40 && x < 56 && y >= 12 && y < 86) ? [255, 255, 255, 255] : [0, 0, 0, 0]));
/** Four coloured quarters, opaque: a badge, shown as uploaded. */
const FULL = rgbaPng(96, 96, (x, y) => (x < 48 ? (y < 48 ? [220, 40, 40, 255] : [40, 160, 60, 255]) : y < 48 ? [40, 80, 220, 255] : [240, 200, 30, 255]));

test.afterAll(async () => {
  await endAll();
});

const eventLogo = (scope: Page | Locator) => scope.getByTestId('event-logo');

async function config(event: TestEvent): Promise<EventAdmin> {
  const res = await (await lead()).get(`${BASE}/api/events/${event.id}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { event: EventAdmin }).event;
}

async function uploadOnSetup(page: Page, event: TestEvent, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.goto(`/events/${event.id}`);
  await expect(page.getByTestId('event-setup')).toBeVisible();
  await page.getByTestId('logo-file').setInputFiles(file);
}

/** What the join-link sign-in page shows: the event logo beside Ground Control, and how it is drawn. */
async function signInLogo(browser: Browser, token: string): Promise<{ kind: string | null; tinted: boolean }> {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto(`/signin#join=${token}`);
  const logo = eventLogo(page);
  await expect(logo).toHaveAttribute('data-logo-kind', /^(mono|full)$/, { timeout: 15_000 });
  await expect(logo.locator('img')).toBeVisible();
  const out = { kind: await logo.getAttribute('data-logo-kind'), tinted: (await logo.locator('img').getAttribute('class'))?.includes('lp-logo-ink') ?? false };
  await ctx.close();
  return out;
}

/** What the desk sidebar's lockup shows for a staff member of the event. */
async function lockupLogo(browser: Browser, event: TestEvent): Promise<{ kind: string | null; white: boolean; rainbow: number }> {
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...DESK });
  await signInContext(ctx, event.password, `TEST-LOGO ${RUN} desk`, 'Gate Crew');
  const page = await ctx.newPage();
  await page.goto('/');
  const logo = eventLogo(page.getByTestId('desk-live'));
  await expect(logo).toHaveAttribute('data-logo-kind', /^(mono|full)$/, { timeout: 20_000 });
  const out = {
    kind: await logo.getAttribute('data-logo-kind'),
    white: (await logo.locator('img').getAttribute('class'))?.includes('lp-logo-white') ?? false,
    rainbow: await logo.getByTestId('event-logo-rainbow').count(),
  };
  await ctx.close();
  return out;
}

test('a lead uploads the logo; it shows on the join-link sign-in, in the desk lockup and on the Ended screen; tinted only when single-colour and transparent', async ({ browser }) => {
  test.setTimeout(180_000);
  const event = await makeEvent({ name: `TEST-LOGO ${RUN} Fest`, posts: [{ id: 'main', label: 'Main Post', short: 'Main' }], teams: [{ id: 'crew', label: 'Gate Crew', short: 'Crew' }] });
  const token = await joinToken(event.id);
  expect((await config(event)).logoUrl).toBeNull();

  const leadCtx = await browser.newContext({ serviceWorkers: 'block', storageState: await (await lead()).storageState() });
  const setup = await leadCtx.newPage();

  // A single-colour transparent logo.
  await uploadOnSetup(setup, event, { name: 'mono.png', mimeType: 'image/png', buffer: MONO });
  // The Logo tile shows it, tinted with the theme like the sign-in page (a white logo on a light tile would vanish).
  await expect(setup.locator('[data-field="logo"] img')).toBeVisible({ timeout: 15_000 });
  await expect(eventLogo(setup.locator('[data-field="logo"]'))).toHaveAttribute('data-logo-kind', 'mono');
  await expect(eventLogo(setup.locator('[data-field="logo"]')).locator('img')).toHaveClass(/lp-logo-ink/);
  await expect.poll(async () => (await config(event)).logoUrl).toMatch(new RegExp(`^/api/events/logo/${event.slug}\\?v=`));
  const monoUrl = (await config(event)).logoUrl!;
  // Served from this origin, as uploaded.
  const served = await setup.request.get(`${BASE}${monoUrl}`);
  expect(served.headers()['content-type']).toBe('image/png');
  expect(Buffer.from(await served.body()).equals(MONO)).toBe(true);

  expect(await signInLogo(browser, token)).toEqual({ kind: 'mono', tinted: true });
  expect(await lockupLogo(browser, event)).toEqual({ kind: 'mono', white: true, rainbow: 1 });

  // Refused: over 1 MB (checked before it is sent), and a file that is not an image (the server sniffs the bytes).
  await uploadOnSetup(setup, event, { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.concat([MONO, Buffer.alloc(1024 * 1024)]) });
  await expect(setup.locator('[data-field="logo"]').locator('..').getByText('At most 1 MB')).toBeVisible();
  await uploadOnSetup(setup, event, { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('TEST-LOGO this is not an image\n'.repeat(20)) });
  await expect(setup.getByText('Use a PNG, WebP or JPEG logo')).toBeVisible({ timeout: 15_000 });
  // The server refuses both on its own too (a client that skips the size check).
  const big = await (await lead()).post(`${BASE}/api/events/${event.id}/logo`, { headers: { origin: BASE }, multipart: { logo: { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.concat([MONO, Buffer.alloc(1024 * 1024)]) } } });
  expect([413, 422]).toContain(big.status());
  const text = await (await lead()).post(`${BASE}/api/events/${event.id}/logo`, { headers: { origin: BASE }, multipart: { logo: { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('not an image') } } });
  expect(text.status()).toBe(415);
  expect((await config(event)).logoUrl).toBe(monoUrl);

  // A coloured, opaque logo replaces it: shown as uploaded everywhere, no tint, no rainbow.
  await uploadOnSetup(setup, event, { name: 'badge.png', mimeType: 'image/png', buffer: FULL });
  await expect.poll(async () => (await config(event)).logoUrl, { timeout: 15_000 }).not.toBe(monoUrl);
  expect(await signInLogo(browser, token)).toEqual({ kind: 'full', tinted: false });
  expect(await lockupLogo(browser, event)).toEqual({ kind: 'full', white: false, rainbow: 0 });

  // The Ended screen (the old join link after the end): the event's logo beside Ground Control.
  await endEvent(event.id);
  const late = await browser.newContext({ serviceWorkers: 'block' });
  const page = await late.newPage();
  await page.goto(`/signin#join=${token}`);
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  await page.getByRole('textbox', { name: 'Your name' }).fill(`TEST-LOGO ${RUN} late`);
  await page.getByRole('textbox', { name: 'Other team' }).fill('Gate Crew');
  await page.getByRole('button', { name: 'Continue' }).click();
  const ended = page.getByTestId('ended');
  await expect(ended).toBeVisible({ timeout: 20_000 });
  await expect(ended.getByRole('img', { name: `${event.name} and Ground Control` })).toBeVisible();
  await expect(eventLogo(ended)).toHaveAttribute('data-logo-kind', 'full', { timeout: 15_000 });
  await expect(eventLogo(ended).locator('img')).toHaveAttribute('src', (await config(event)).logoUrl!);
  await late.close();
  await leadCtx.close();
});
