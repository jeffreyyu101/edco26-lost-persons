// (Events) Event setup for a non-developer on a phone (cut-over drill, 2026-11-10):
//   * realistic post and team names with Short left empty: the Short field shows the derived short as its placeholder,
//     the chip shows it, and Create succeeds;
//   * a duplicate Short is marked on the item: the sheet's Short field, and (an event read back with two equal
//     shorts) the second chip;
//   * join-link creation names the dates as the problem;
//   * a join link's sign-in shows only its own event's teams;
//   * a single-colour logo on the lead tiles follows the theme (ink on light, white on dark).
// Synthetic names only; every event is ended at the end of the file.
import { execFileSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';
import type { EventAdmin } from '@/lib/api-types';
import { localDbUrl } from '../../scripts/test-env.mjs';
import { BASE, endAll, joinToken, lead, makeEvent } from './helpers/events';
import { rgbaPng } from './helpers/png';

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

const RUN = Date.now().toString(36).slice(-6);
const created: string[] = [];

/** A black "T" on a transparent square: single colour, mostly transparent. */
const MONO = rgbaPng(96, 96, (x, y) => ((y >= 12 && y < 28 && x >= 12 && x < 84) || (x >= 40 && x < 56 && y >= 12 && y < 86) ? [0, 0, 0, 255] : [0, 0, 0, 0]));

test.afterAll(async () => {
  const ctx = await lead();
  for (const id of created) {
    await ctx.post(`${BASE}/api/events/${id}/go-live`, { data: {} });
    await ctx.post(`${BASE}/api/events/${id}/end`, { data: {} });
  }
  await endAll();
});

async function leadPage(browser: Browser, colorScheme: 'light' | 'dark' = 'light'): Promise<Page> {
  const ctx = await browser.newContext({ serviceWorkers: 'block', colorScheme, storageState: await (await lead()).storageState() });
  return ctx.newPage();
}

async function apiEvent(body: Record<string, unknown>): Promise<EventAdmin> {
  const res = await (await lead()).post(`${BASE}/api/events`, {
    // A post and a team, so afterAll can take it live and end it.
    data: { slug: `t-su-${RUN}-${Math.random().toString(36).slice(2, 7)}`, name: `TEST-SU ${RUN}`, startsOn: day(0), endsOn: day(1), posts: [{ label: 'Main Post' }], teams: [{ label: 'Rovers' }], ...body },
  });
  expect(res.status(), await res.text()).toBe(201);
  const event = ((await res.json()) as { event: EventAdmin }).event;
  created.push(event.id);
  return event;
}

function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

async function addItem(page: Page, list: 'setup-posts' | 'setup-teams', label: string) {
  await page.getByTestId(`${list}-add`).click();
  await page.getByTestId('item-label').fill(label);
  await page.getByTestId('item-save').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('Warped Tour posts and a long team name, every Short empty: derived, shown, created', async ({ browser }) => {
  const page = await leadPage(browser);
  await page.goto('/events/new');
  await page.getByTestId('setup-name').fill(`TEST-SU Warped ${RUN}`);

  // The Short field shows what will be used, live as the label is typed.
  await page.getByTestId('setup-posts-add').click();
  await page.getByTestId('item-label').fill('FA 1 – Main');
  await expect(page.getByTestId('item-short')).toHaveAttribute('placeholder', 'FA 1 – Main');
  await page.getByTestId('item-label').fill('FA 1 – Main Stage');
  await expect(page.getByTestId('item-short')).toHaveAttribute('placeholder', 'FA 1');
  await expect(page.getByTestId('item-short')).toHaveValue('');
  await page.getByTestId('item-save').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  for (const label of ['FA 2 – Vans Stage', 'Main Medical', 'Command', 'Roaming', 'Gate A']) await addItem(page, 'setup-posts', label);
  await addItem(page, 'setup-teams', 'Ground Control Dispatch Team');
  await expect(page.getByTestId('setup-posts-chip')).toHaveText(['FA 1 – Main StageFA 1', 'FA 2 – Vans StageFA 2', 'Main Medical', 'Command', 'Roaming', 'Gate A']);
  await expect(page.getByTestId('setup-teams-chip-short')).toHaveText(['Ground Control Dispatch']);

  await page.getByTestId('setup-create').click();
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').pop()!;
  created.push(id);
  const event = ((await (await (await lead()).get(`${BASE}/api/events/${id}`)).json()) as { event: EventAdmin }).event;
  expect(event.posts.map((p) => p.short)).toEqual(['FA 1', 'FA 2', 'Main Medical', 'Command', 'Roaming', 'Gate A']);
  expect(event.teams.map((t) => t.short)).toEqual(['Ground Control Dispatch']);
  // Read back: the derived shorts are not shown as typed (the field stays empty, following the label).
  await page.getByRole('button', { name: 'Edit post FA 1 – Main Stage' }).click();
  await expect(page.getByTestId('item-short')).toHaveValue('');
  await expect(page.getByTestId('item-short')).toHaveAttribute('placeholder', 'FA 1');
  await page.context().close();
});

test('a duplicate Short is marked on the Short field of the sheet', async ({ browser }) => {
  const page = await leadPage(browser);
  await page.goto('/events/new');
  await addItem(page, 'setup-posts', 'Gate A – North Side');
  await page.getByTestId('setup-posts-add').click();
  await page.getByTestId('item-label').fill('Gate A – South Side');
  await page.getByTestId('item-save').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('item-short')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('item-label')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('item-short')).toHaveAccessibleDescription('Short already used');
  await expect(page.getByTestId('item-short')).toBeFocused();
  // Typing a Short of its own fixes it.
  await page.getByTestId('item-short').fill('Gate A S');
  await page.getByTestId('item-save').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('setup-posts-chip')).toHaveText(['Gate A – North SideGate A', 'Gate A – South SideGate A S']);
  await page.context().close();
});

test('an event read back with two equal shorts: Save marks the second chip, and its sheet opens on Short', async ({ browser }) => {
  const event = await apiEvent({ posts: [{ label: 'North Gate', short: 'North' }, { label: 'Main Stage' }, { label: 'North Tent', short: 'Tent' }], teams: [{ label: 'Rovers' }] });
  // Data from before the rule (the drill saved two posts with Short "North").
  execFileSync('psql', [localDbUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-c', `update public.events set posts = jsonb_set(posts, '{2,short}', '"NORTH"') where id = '${event.id}'`]);
  const page = await leadPage(browser);
  await page.goto(`/events/${event.id}`);
  await page.getByTestId('setup-name').fill(`TEST-SU Renamed ${RUN}`);
  await page.getByTestId('setup-save').click();
  const chips = page.getByTestId('setup-posts-chip');
  await expect(chips.nth(2)).toHaveAttribute('data-invalid', '');
  await expect(chips.nth(0)).not.toHaveAttribute('data-invalid', '');
  await expect(page.getByTestId('setup-posts')).not.toHaveAttribute('data-invalid', '');
  await expect(page.locator('#setup-err-posts')).toHaveText('North Tent: Short already used');
  await expect(page.getByText('Check the details and try again')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit post North Tent' })).toBeFocused();
  await page.getByRole('button', { name: 'Edit post North Tent' }).click();
  await expect(page.getByTestId('item-short')).toHaveAttribute('aria-invalid', 'true');
  await page.getByTestId('item-short').fill('N Tent');
  await page.getByTestId('item-save').click();
  await expect(chips.nth(2)).not.toHaveAttribute('data-invalid', '');
  await page.getByTestId('setup-save').click();
  await expect(page.getByTestId('setup-save')).toHaveCount(0);
  await page.context().close();
});

test('join link: the dates are named when they are the problem', async ({ browser }) => {
  const past = await apiEvent({ startsOn: '2025-06-01', endsOn: '2025-06-02' });
  const far = await apiEvent({ startsOn: day(120), endsOn: day(121) });
  const page = await leadPage(browser);
  for (const [event, message] of [
    [past, 'Event dates have passed'],
    [far, 'Event is more than 90 days away'],
  ] as const) {
    await page.goto(`/events/${event.id}`);
    await page.getByTestId('join-link-new').click();
    await expect(page.locator('#setup-err-joinLink')).toHaveText(message);
    await expect(page.getByText('Pick an expiry within 90 days')).toHaveCount(0);
  }
  await page.context().close();
});

test('a join link shows only its own event\'s teams', async ({ browser }) => {
  const a = await makeEvent({ name: `TEST-SU A ${RUN}`, posts: [{ label: 'Main Post', short: 'Main' }], teams: [{ label: `Alpha ${RUN}`, short: `Alpha ${RUN}` }, { label: 'Medical', short: 'Med', medical: true }] });
  const b = await makeEvent({ name: `TEST-SU B ${RUN}`, posts: [{ label: 'Main Post', short: 'Main' }], teams: [{ label: `Bravo ${RUN}`, short: `Bravo ${RUN}` }, { label: 'Rovers', short: 'Rovers' }] });
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto(`/signin#join=${await joinToken(a.id)}`);
  await expect(page.getByRole('radio')).toHaveText([`Alpha ${RUN}`, 'Med']);
  await page.goto('about:blank');
  await page.goto(`/signin#join=${await joinToken(b.id)}`);
  await expect(page.getByRole('radio')).toHaveText([`Bravo ${RUN}`, 'Rovers']);
  // No link (the password path): every running event's teams.
  await ctx.clearCookies();
  await page.evaluate(() => sessionStorage.clear());
  await page.goto('/signin');
  for (const label of [`Alpha ${RUN}`, `Bravo ${RUN}`, 'Rovers']) await expect(page.getByRole('radio', { name: label })).toBeVisible();
  await ctx.close();
});

test('a single-colour logo on the lead tiles follows the theme', async ({ browser }) => {
  const event = await apiEvent({ posts: [{ label: 'Main Post' }], teams: [{ label: 'Rovers' }] });
  const up = await (await lead()).post(`${BASE}/api/events/${event.id}/logo`, { multipart: { logo: { name: 'mono.png', mimeType: 'image/png', buffer: MONO } } });
  expect(up.status(), await up.text()).toBe(200);
  for (const scheme of ['light', 'dark'] as const) {
    const page = await leadPage(browser, scheme);
    await page.goto(`/events/${event.id}`);
    const logo = page.getByTestId('event-setup').getByTestId('event-logo').first();
    await expect(logo).toHaveAttribute('data-logo-kind', 'mono', { timeout: 15_000 });
    await expect(logo.locator('img')).toHaveClass(/lp-logo-ink/);
    const filter = await logo.locator('img').evaluate((img) => getComputedStyle(img).filter);
    if (scheme === 'dark') expect(filter).toContain('invert(1)');
    else expect(filter).not.toContain('invert');
    // The Events list tile too.
    await page.goto('/events');
    await expect(page.getByTestId('events-screen').getByTestId('event-logo').locator('img[class*="lp-logo-ink"]').first()).toBeVisible({ timeout: 15_000 });
    await page.context().close();
  }
});
