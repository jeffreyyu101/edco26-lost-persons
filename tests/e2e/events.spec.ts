import { expect, test, type Page } from '@playwright/test';
import './helpers/api-event';
import { BASE, apiCreate, endAll, endEvent, goLive, joinToken, makeEvent, moveEndBack, rowNames, signInContext, staffCookie, type TestEvent } from './helpers/events';

// (Events, phase 2) The client across events, against real events made through the lead routes:
//   * config as data: a 1-post practice event and a 6-post live one (another time zone, the show day from 9 AM): the
//     Reporting from picker, the Last seen chips, the dashboard's posts, the stage chips, the time zone;
//   * one browser profile, two events: no cached row or queued request of one reaches the other;
//   * practice → live drops the practice rows from the phone;
//   * the Ended screen from a poll, a write, and sign-in: inside the 24 h after End its password and join link both
//     open it; after them the old password is a wrong password and the old join link (its slug) still opens it.
// Every event is ended in afterAll. Synthetic names only. Runs in both browsers (chromium and webkit projects).

test.describe.configure({ mode: 'serial' });
// The service worker never decides anything here (no offline reload), and blocking it keeps page.route reliable in WebKit.
test.use({ serviceWorkers: 'block' });

const RUN = Date.now().toString(36);
let n = 0;
const uniq = (label: string) => `TEST-EV-${RUN}-${(n += 1)} ${label}`;
const TEAMS = [
  { id: 'crew', label: 'Gate Crew', short: 'Crew' },
  { id: 'aid', label: 'First Aid', short: 'Aid', medical: true },
];

test.afterAll(async () => {
  await endAll();
});

const list = (page: Page) => page.getByTestId('request-list');
const submit = (page: Page) => page.getByTestId('request-form-submit');
const rowNamed = (page: Page, name: string) => page.locator('[data-request-id]', { hasText: name });

async function openApp(page: Page, path = '/') {
  await page.goto(path);
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
}

async function pickPost(page: Page, post: string) {
  await page.getByRole('button', { name: /^Reporting from/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Reporting from' });
  await sheet.locator('label', { hasText: post }).click();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();
}

async function expectEnded(page: Page, event: TestEvent) {
  await expect(page).toHaveURL(/\/signin\?ended=1$/, { timeout: 30_000 });
  const ended = page.getByTestId('ended');
  await expect(ended).toBeVisible();
  await expect(ended.getByRole('heading', { level: 1, name: event.name })).toBeVisible();
  await expect(ended.getByRole('img', { name: 'Archived event' })).toBeVisible();
  await expect(ended).toContainText('This event is now closed. Thank you for your work.');
  await expect(page.locator('input')).toHaveCount(0);
  await expect(page.getByLabel('Event password')).toHaveCount(0);
}

test('a 1-post practice event: the practice chip on every screen, its one post and its Last seen chips', async ({ page, context }) => {
  const event = await makeEvent({ name: uniq('One post'), practice: true, posts: [{ id: 'aid-station', label: 'Aid Station', short: 'Aid' }], teams: TEAMS, lastSeen: ['Ferris wheel'], mainMedical: 'Aid Tent' });
  await signInContext(context, event.password, uniq('Staff'), 'Gate Crew');
  await apiCreate(context.request, { name: uniq('Practice row'), reportingLocation: 'Aid Station' });
  await openApp(page);
  await expect(list(page)).toBeVisible();
  // The header chip: Practice (amber half ring), named in words.
  await expect(page.getByRole('img', { name: 'Practice event' })).toBeVisible();
  // The form: its header has the chip too; the picker lists the event's one post and Other, nothing of EDC.
  await openApp(page, '/?new=1');
  await expect(submit(page)).toBeVisible();
  await expect(page.getByTestId('request-form').getByRole('img', { name: 'Practice event' })).toBeVisible();
  await page.getByRole('button', { name: /^Reporting from/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Reporting from' });
  await expect(sheet.getByRole('radio')).toHaveCount(2);
  await expect(sheet.locator('label')).toHaveText(['Aid Station', 'Other']);
  await sheet.locator('label', { hasText: 'Aid Station' }).click();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('textbox', { name: /^Last seen/ }).first().focus();
  await expect(page.getByRole('group', { name: 'Add a place to Last seen' }).getByRole('button')).toHaveText(['Ferris wheel']);
  await expect(page.getByText('kineticFIELD')).toHaveCount(0);
});

test('a 6-post live event in Los Angeles, the show day from 9 AM: the live chip, its time zone, four busiest posts and Other', async ({ page, context }) => {
  const posts = ['North', 'South', 'East', 'West', 'Hill', 'Pier'].map((p) => ({ id: p.toLowerCase(), label: `${p} Gate`, short: p }));
  const event = await makeEvent({ name: uniq('Six posts'), posts, teams: TEAMS, timezone: 'America/Los_Angeles', dayStartHour: 9 });
  await signInContext(context, event.password, uniq('Staff'), 'Gate Crew');
  const counts = [5, 4, 3, 2, 1, 1];
  let first: { createdAt: string; name: string } | null = null;
  for (const [i, c] of counts.entries()) {
    for (let k = 0; k < c; k += 1) {
      const row = await apiCreate(context.request, { name: uniq(`At ${posts[i]!.short}`), reportingLocation: posts[i]!.label });
      first ??= row;
    }
  }
  await openApp(page);
  await expect(list(page)).toBeVisible();
  await expect(page.getByRole('img', { name: 'Live event' })).toBeVisible();
  // Times are the event's (Los Angeles), not the device's or New York's.
  const la = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }).format(new Date(first!.createdAt));
  await expect(rowNamed(page, first!.name)).toContainText(la.replace(/\s?[AP]M$/, ''));
  // The dashboard: Today (the show day), By post: the four busiest posts by name, then Other.
  await openApp(page, '/?dashboard=1');
  await expect(page.getByTestId('range').getByRole('radio', { name: 'Today' })).toBeChecked();
  await expect(page.getByText('Tonight')).toHaveCount(0);
  await page.getByTestId('calls-view').getByRole('radio', { name: 'By post' }).click();
  const legend = page.getByTestId('calls').locator('span', { has: page.locator('i') });
  await expect(legend.filter({ hasText: /^(North|South|East|West|Other)$/ })).toHaveCount(5);
  await expect(legend.filter({ hasText: /^(Hill|Pier)$/ })).toHaveCount(0);
  await expect(page.getByText('By tent')).toHaveCount(0);
});

test('one browser profile, two events: no cached row or queued request of one reaches the other', async ({ page, context }) => {
  const x = await makeEvent({ name: uniq('Event X'), posts: [{ id: 'x', label: 'X Post', short: 'X' }], teams: TEAMS });
  const y = await makeEvent({ name: uniq('Event Y'), posts: [{ id: 'y', label: 'Y Post', short: 'Y' }], teams: TEAMS });
  const staff = uniq('Both');
  await signInContext(context, x.password, staff, 'Gate Crew');
  const xRow = await apiCreate(context.request, { name: uniq('X row'), reportingLocation: 'X Post' });
  await openApp(page);
  await expect(rowNamed(page, xRow.name)).toBeVisible();
  // A request saved offline in X.
  await openApp(page, '/?new=1');
  await expect(submit(page)).toBeVisible();
  await context.setOffline(true);
  const queued = uniq('Queued in X');
  await pickPost(page, 'X Post');
  await page.getByRole('group', { name: 'Missing person' }).getByLabel('Name', { exact: true }).fill(queued);
  await submit(page).click();
  await expect(page.getByText('Saved on this phone', { exact: true })).toBeVisible();
  // Meanwhile this browser signs in to Y (as another tab would): the cookie is Y's now.
  const yCookie = await staffCookie(y.password, staff, 'Gate Crew');
  const yRow = await apiCreate(yCookie.api, { name: uniq('Y row'), reportingLocation: 'Y Post' });
  await context.clearCookies();
  await context.addCookies([{ name: 'lp_session', value: yCookie.value, url: BASE }]);
  await context.setOffline(false);
  // The tab learns it is Y's now (the server refuses X's write for Y's cookie): Y's rows only, X's queued request unsent.
  await expect(rowNamed(page, yRow.name)).toBeVisible({ timeout: 30_000 });
  await expect(rowNamed(page, xRow.name)).toHaveCount(0);
  await page.waitForTimeout(8_000);
  expect(await rowNames(yCookie.api)).not.toContain(queued);
  await openApp(page);
  await expect(rowNamed(page, yRow.name)).toBeVisible();
  await expect(rowNamed(page, xRow.name)).toHaveCount(0);
  await expect(page.getByText(queued)).toHaveCount(0);
  // Back in X: its queued request goes to X, once.
  const xCookie = await staffCookie(x.password, staff, 'Gate Crew');
  await context.clearCookies();
  await context.addCookies([{ name: 'lp_session', value: xCookie.value, url: BASE }]);
  await openApp(page);
  await expect.poll(async () => (await rowNames(xCookie.api)).filter((name) => name === queued).length, { timeout: 45_000 }).toBe(1);
  await expect(rowNamed(page, yRow.name)).toHaveCount(0);
  expect(await rowNames(yCookie.api)).not.toContain(queued);
  await yCookie.api.dispose();
  await xCookie.api.dispose();
});

test('practice → live: the practice rows leave the phone and the chip turns Live', async ({ page, context }) => {
  const event = await makeEvent({ name: uniq('Go live'), practice: true, posts: [{ id: 'p', label: 'Main Post', short: 'Main' }], teams: TEAMS });
  await signInContext(context, event.password, uniq('Staff'), 'Gate Crew');
  const practice = await apiCreate(context.request, { name: uniq('Practice only'), reportingLocation: 'Main Post' });
  await openApp(page);
  await expect(rowNamed(page, practice.name)).toBeVisible();
  await expect(page.getByRole('img', { name: 'Practice event' })).toBeVisible();
  await goLive(event.id);
  await expect(page.getByRole('img', { name: 'Live event' })).toBeVisible({ timeout: 30_000 });
  await expect(rowNamed(page, practice.name)).toHaveCount(0, { timeout: 30_000 });
  // A reload keeps it gone (the phone's cache of the event was dropped): the live log starts empty.
  await openApp(page);
  await expect(page.getByRole('img', { name: 'Live event' })).toBeVisible();
  await page.waitForTimeout(3_000);
  await expect(rowNamed(page, practice.name)).toHaveCount(0);
});

test('Ended from a background poll: signed out, the Ended screen; the app does not come back', async ({ page, context }) => {
  const event = await makeEvent({ name: uniq('Ends on a poll'), posts: [{ id: 'p', label: 'Main Post', short: 'Main' }], teams: TEAMS });
  await signInContext(context, event.password, uniq('Staff'), 'Gate Crew');
  await apiCreate(context.request, { name: uniq('Row'), reportingLocation: 'Main Post' });
  await openApp(page);
  await expect(list(page)).toBeVisible();
  await endEvent(event.id);
  await expectEnded(page, event);
  // Signed out: the app sends this browser to sign-in (not back to the Ended event).
  await page.goto('/');
  await expect(page).toHaveURL(/\/signin/);
  expect((await context.cookies()).find((c) => c.name === 'lp_session')).toBeUndefined();
});

test('Ended from a write (a status tap), polls held: the Ended screen, no "only the person who logged it" toast', async ({ page, context }) => {
  const event = await makeEvent({ name: uniq('Ends on a write'), posts: [{ id: 'p', label: 'Main Post', short: 'Main' }], teams: TEAMS });
  await signInContext(context, event.password, uniq('Staff'), 'Gate Crew');
  const row = await apiCreate(context.request, { name: uniq('Row'), reportingLocation: 'Main Post' });
  await openApp(page, `/?r=${row.id}`);
  await expect(page.getByRole('heading', { level: 1, name: row.name })).toBeVisible();
  // No poll may learn it first.
  await page.route('**/api/sync**', (route) => route.abort());
  await endEvent(event.id);
  await page.getByTestId('not-found-answer').click();
  await expectEnded(page, event);
  await expect(page.getByText('Only the person who logged it can do that')).toHaveCount(0);
});

test("Ended from sign-in: inside 24 h its password opens the Ended screen; after them the old join link does and the old password is a wrong password", async ({ page }) => {
  const event = await makeEvent({ name: uniq('Ended before'), posts: [{ id: 'p', label: 'Main Post', short: 'Main' }], teams: TEAMS });
  const token = await joinToken(event.id);
  await endEvent(event.id);
  // (Grace period) Held: the password it had opens the Ended screen, and signs nobody in.
  await page.goto('/signin');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  await page.getByRole('textbox', { name: 'Your name' }).fill(uniq('Late'));
  await page.getByRole('textbox', { name: 'Other team' }).fill('Gate Crew');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Event password').fill(event.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expectEnded(page, event);
  // 25 h later (the end moved back): the password is cleared, so the old one is just refused, like any wrong password.
  moveEndBack(event.id, 25);
  await page.goto('/signin');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  await page.getByRole('textbox', { name: 'Your name' }).fill(uniq('Late'));
  await page.getByRole('textbox', { name: 'Other team' }).fill('Gate Crew');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Event password').fill(event.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('signin').getByRole('alert')).toContainText('Incorrect password');
  await expect(page.getByTestId('ended')).toHaveCount(0);
  // The join link its staff were given: its slug names the ended event.
  await page.goto(`/signin#join=${token}`);
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  await page.getByRole('textbox', { name: 'Your name' }).fill(uniq('Late'));
  await page.getByRole('textbox', { name: 'Other team' }).fill('Gate Crew');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expectEnded(page, event);
});
