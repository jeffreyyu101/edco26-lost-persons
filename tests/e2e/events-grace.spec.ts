// (Grace period, 2026-11-10) For 24 hours after End an event keeps its staff password and join link:
//   * inside them: a lead ends a live event by mistake, staff see the Ended screen (their open phone, and sign-in with
//     the password they have), the Reopen sheet says Password Kept, Join link Kept and the time left, and after
//     Reopen the same password signs staff back in to their earlier requests;
//   * after them (the server's clock moved the way these tests move it: ended_at goes back 25 h): the old password
//     is an incorrect password, the old join link still opens the Ended screen, and the Reopen sheet says New one
//     needed for both, with no time left.
// Synthetic names only; every event is ended (and its password and link dropped) in afterAll. Both browsers.
import './helpers/api-event';
import { randomInt } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { loadTestEnv } from '../../scripts/test-env.mjs';
import { BASE, apiCreate, endAll, joinToken, makeEvent, moveEndBack, signInContext, type TestEvent } from './helpers/events';

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

const RUN = Date.now().toString(36);
let seq = 0;
const uniq = (label: string) => `TEST-GR-${RUN}-${(seq += 1)} ${label}`;
const ENV: Record<string, string | undefined> = loadTestEnv();
const TEAMS = [
  { id: 'crew', label: 'Gate Crew', short: 'Crew' },
  { id: 'aid', label: 'First Aid', short: 'Aid', medical: true },
];
const POSTS = [{ id: 'p', label: 'Main Post', short: 'Main' }];
const fakeIp = () => `100.${64 + randomInt(64)}.${randomInt(256)}.${1 + randomInt(254)}`;

test.afterAll(async () => {
  await endAll();
});

const rowNamed = (page: Page, name: string) => page.locator('[data-request-id]', { hasText: name });

/** A lead's browser context (the lead passcode, through POST /api/session). */
async function leadContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const ip = fakeIp();
  const res = await ctx.request.post(`${BASE}/api/session`, {
    headers: { origin: BASE, 'x-real-ip': ip, 'x-vercel-forwarded-for': ip },
    data: { staffName: uniq('Lead'), team: 'Other', otherTeam: 'Ground Control', password: ENV['LP_LEAD_PASSCODE'] },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ctx;
}

async function openSetup(page: Page, event: TestEvent) {
  await page.goto(`/events/${event.id}`);
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  await expect(page.getByTestId('event-setup')).toBeVisible();
}

/** Sign-in on the page: name, Other team, then the password (or, with `invite`, the join link skips it). */
async function signInOnPage(page: Page, opts: { name: string; password?: string; invite?: string }) {
  await page.goto(opts.invite ? `/signin#join=${opts.invite}` : '/signin');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  const name = page.getByRole('textbox', { name: 'Your name' });
  const password = page.getByLabel('Event password');
  // A remembered name and team (after a sign-in on this page) skip step 1 for a password sign-in.
  await expect(name.or(password)).toBeVisible();
  if (await name.isVisible()) {
    await name.fill(opts.name);
    await page.getByRole('textbox', { name: 'Other team' }).fill('Gate Crew');
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  if (opts.password !== undefined) {
    await page.getByLabel('Event password').fill(opts.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
}

async function expectEnded(page: Page, event: TestEvent) {
  await expect(page).toHaveURL(/\/signin\?ended=1$/, { timeout: 30_000 });
  const ended = page.getByTestId('ended');
  await expect(ended).toBeVisible();
  await expect(ended.getByRole('heading', { level: 1, name: event.name })).toBeVisible();
  await expect(page.getByLabel('Event password')).toHaveCount(0);
}

test('End by mistake, Reopen inside 24 h: staff see Ended, then sign back in with the same password to their requests', async ({ browser, page, context }) => {
  test.setTimeout(150_000);
  const event = await makeEvent({ name: uniq('Ended by mistake'), posts: POSTS, teams: TEAMS });
  const token = await joinToken(event.id);
  const staffName = uniq('Staff');
  await signInContext(context, event.password, staffName, 'Gate Crew');
  const row = await apiCreate(context.request, { name: uniq('Before the end'), reportingLocation: 'Main Post' });
  await page.goto('/');
  await expect(rowNamed(page, row.name)).toBeVisible({ timeout: 20_000 });

  // The lead ends it: the End sheet's line says it can come back with the same password.
  const leadCtx = await leadContext(browser);
  const leadPage = await leadCtx.newPage();
  await openSetup(leadPage, event);
  await leadPage.getByTestId('stage-end').click();
  const end = leadPage.getByRole('dialog', { name: 'End event' });
  // No sentence on screen: rows and chips; the sentence is the sheet's description.
  await expect(end).toHaveAccessibleDescription('Staff are signed out and nothing is deleted; within 24 hours it can be reopened with the same password and join link.');
  await expect(end.getByTestId('end-staff')).toContainText('Signed out');
  await expect(end.getByTestId('end-records')).toContainText('Kept');
  await expect(end.getByTestId('end-password')).toContainText('Kept 24 h');
  await expect(end.getByTestId('end-join-link')).toContainText('Kept 24 h');
  await end.getByTestId('stage-confirm').click();
  await expect(end).toHaveCount(0);
  await expect(leadPage.getByTestId('event-stage')).toHaveText('Archived');

  // Staff: the open phone learns it at its next poll; signing in again with the password they have is the Ended
  // screen too (held, not signed in).
  await expectEnded(page, event);
  await signInOnPage(page, { name: staffName, password: event.password });
  await expectEnded(page, event);
  expect((await context.cookies()).find((c) => c.name === 'lp_session')).toBeUndefined();

  // Reopen: the sheet shows what it keeps, and the time left.
  await leadPage.getByTestId('stage-reopen').click();
  const reopen = leadPage.getByRole('dialog', { name: 'Reopen' });
  await expect(reopen.getByTestId('reopen-keeps')).toHaveAttribute('data-held', 'true');
  await expect(reopen.getByTestId('reopen-password')).toHaveAttribute('data-kept', 'true');
  await expect(reopen.getByTestId('reopen-password')).toContainText('Kept');
  await expect(reopen.getByTestId('reopen-join-link')).toHaveAttribute('data-kept', 'true');
  await expect(reopen.getByTestId('reopen-left')).toContainText(/^(23 h [0-5]?\d m|24 h 0 m)/);
  await expect(reopen).toHaveAccessibleDescription('Open requests resume as they were; staff sign in again.');
  await expect(reopen.getByTestId('reopen-staff')).toContainText('Sign in again');
  await expect(reopen.getByTestId('reopen-open')).toContainText(/^\d+$/);
  await reopen.getByTestId('stage-confirm').click();
  await expect(reopen).toHaveCount(0);
  await expect(leadPage.getByTestId('event-stage')).toHaveText('Live');
  await expect(leadPage.getByTestId('password-state')).toContainText('••••••••');
  await expect(leadPage.getByTestId('join-link-state')).not.toContainText('—');

  // The same password signs staff back in; their earlier request is there and they carry on.
  await signInOnPage(page, { name: staffName, password: event.password });
  await expect(page).toHaveURL(`${BASE}/`, { timeout: 20_000 });
  await expect(rowNamed(page, row.name)).toBeVisible({ timeout: 20_000 });
  // The join link they were given works again too.
  const other = await browser.newContext({ serviceWorkers: 'block' });
  const viaLink = await other.newPage();
  await signInOnPage(viaLink, { name: uniq('Link'), invite: token });
  await expect(viaLink).toHaveURL(`${BASE}/`, { timeout: 20_000 });
  await expect(rowNamed(viaLink, row.name)).toBeVisible({ timeout: 20_000 });
  await other.close();
  await leadCtx.close();
});

test('End sheet of an event with no join link: Password Kept 24 h, Join link a dash, and the description matches', async ({ browser }) => {
  const event = await makeEvent({ name: uniq('No link'), posts: POSTS, teams: TEAMS });
  const leadCtx = await leadContext(browser);
  const leadPage = await leadCtx.newPage();
  await openSetup(leadPage, event);
  await leadPage.getByTestId('stage-end').click();
  const end = leadPage.getByRole('dialog', { name: 'End event' });
  await expect(end).toHaveAccessibleDescription('Staff are signed out and nothing is deleted; within 24 hours it can be reopened with the same password.');
  await expect(end.getByTestId('end-password')).toContainText('Kept 24 h');
  await expect(end.getByTestId('end-join-link')).toHaveText('—This event has no working join link.');
  await expect(end.getByTestId('end-join-link')).not.toContainText('Kept');
  await leadCtx.close();
});

test('After 24 h: the old password is incorrect, the old link shows Ended, and Reopen needs a new password and link', async ({ browser, page }) => {
  test.setTimeout(120_000);
  const event = await makeEvent({ name: uniq('Ended yesterday'), posts: POSTS, teams: TEAMS });
  const token = await joinToken(event.id);
  const leadCtx = await leadContext(browser);
  const ended = await leadCtx.request.post(`${BASE}/api/events/${event.id}/end`, { headers: { origin: BASE }, data: {} });
  expect(ended.status()).toBe(200);
  moveEndBack(event.id, 25);

  await signInOnPage(page, { name: uniq('Late'), password: event.password });
  await expect(page.getByTestId('signin').getByRole('alert')).toContainText('Incorrect password');
  await expect(page.getByTestId('ended')).toHaveCount(0);
  await signInOnPage(page, { name: uniq('Late'), invite: token });
  await expectEnded(page, event);

  const leadPage = await leadCtx.newPage();
  await openSetup(leadPage, event);
  await leadPage.getByTestId('stage-reopen').click();
  const reopen = leadPage.getByRole('dialog', { name: 'Reopen' });
  await expect(reopen.getByTestId('reopen-keeps')).toHaveAttribute('data-held', 'false');
  await expect(reopen.getByTestId('reopen-password')).toHaveAttribute('data-kept', 'false');
  await expect(reopen.getByTestId('reopen-password')).toContainText('New one needed');
  await expect(reopen.getByTestId('reopen-join-link')).toContainText('New one needed');
  await expect(reopen.getByTestId('reopen-left')).toHaveCount(0);
  await reopen.getByTestId('stage-confirm').click();
  await expect(reopen).toHaveCount(0);
  await expect(leadPage.getByTestId('event-stage')).toHaveText('Live');
  await expect(leadPage.getByTestId('password-state')).toContainText('—');
  await expect(leadPage.getByTestId('join-link-state')).toContainText('—');
  await signInOnPage(page, { name: uniq('Late'), password: event.password });
  await expect(page.getByTestId('signin').getByRole('alert')).toContainText('Incorrect password');
  await leadCtx.close();
});
