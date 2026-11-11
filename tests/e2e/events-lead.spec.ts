// (Events, phase 2b) The lead screens: Events, Event setup, the stage sheets, the desk's event switcher and the lead
// passcode. The whole "no developer" journey on a phone; two live events from the switcher on the desk; each inline
// field error; an archived event's read-only setup; staff kept out of every lead screen.
//
// Every event here is synthetic ("TEST-L …", a per-run tag). At the end its staff password and join link are cleared and
// it is ended (an archived event's kept hash would be one more bcrypt compare at every later sign-in).
import { randomInt, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { EventAdmin, RequestSummary } from '../../lib/api-types';
import { TEST_EVENT_ID, loadTestEnv, testBaseUrl } from '../../scripts/test-env.mjs';
import { axeViolations } from './helpers/a11y';
import { forgetSignedInStates, newSignedInContext } from './helpers/session';

const BASE = testBaseUrl();
const ENV: Record<string, string | undefined> = loadTestEnv();
const LEAD_PASSCODE = ENV['LP_LEAD_PASSCODE']!;
const TAG = Date.now().toString(36).slice(-6);
const DESK = { width: 1280, height: 800 };
const ORIGIN = { origin: BASE };

const created = new Set<string>();

function fakeIp(): string {
  return `100.${64 + randomInt(64)}.${randomInt(256)}.${1 + randomInt(254)}`;
}

function today(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const secret = (what: string) => `${what}-${TAG}-${randomUUID().slice(0, 8)}`;

/** A browser context signed in with the lead passcode (no event open), through POST /api/session. */
async function leadContext(browser: Browser, opts: { viewport?: { width: number; height: number } } = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({ ...(opts.viewport ? { viewport: opts.viewport, isMobile: false, hasTouch: false } : {}), serviceWorkers: 'block' });
  const ip = fakeIp();
  const res = await ctx.request.post('/api/session', {
    headers: { ...ORIGIN, 'x-vercel-forwarded-for': ip, 'x-real-ip': ip },
    data: { staffName: `TEST-L Lead ${TAG}`, team: 'Dispatch', password: LEAD_PASSCODE },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ctx;
}

/** A staff member signs in to an event with its password: the status (200, 401, 410). */
async function staffSignIn(ctx: BrowserContext | APIRequestContext, password: string): Promise<number> {
  const request = 'request' in ctx ? ctx.request : ctx;
  const ip = fakeIp();
  const res = await request.post('/api/session', {
    headers: { ...ORIGIN, 'x-vercel-forwarded-for': ip, 'x-real-ip': ip },
    data: { staffName: `TEST-L Staff ${TAG}`, team: 'Dispatch', password },
  });
  return res.status();
}

/** A staff member signs in with a join link token ("<slug>.<code>"): the status. */
async function staffJoin(ctx: BrowserContext, invite: string): Promise<number> {
  const ip = fakeIp();
  const res = await ctx.request.post('/api/session', {
    headers: { ...ORIGIN, 'x-vercel-forwarded-for': ip, 'x-real-ip': ip },
    data: { staffName: `TEST-L Staff ${TAG}`, team: 'Dispatch', invite },
  });
  return res.status();
}

async function logRequest(ctx: BrowserContext, post: string, name: string): Promise<RequestSummary & { http: number }> {
  const res = await ctx.request.post('/api/requests', {
    headers: ORIGIN,
    data: { clientMutationId: randomUUID(), reportingLocation: post, name: `TEST-L ${name} ${TAG}`, age: '24', gender: 'Female', contactPhone: '407-555-0100' },
  });
  const http = res.status();
  return { ...((http === 201 ? ((await res.json()) as { request: RequestSummary }).request : {}) as RequestSummary), http };
}

/** An event made through the lead routes: posts, teams, a staff password, and the stage asked for. */
async function apiEvent(lead: APIRequestContext, name: string, stage: 'practice' | 'live' = 'practice', password = secret('pw')): Promise<{ event: EventAdmin; password: string }> {
  const slug = `t-l-${TAG}-${randomUUID().slice(0, 6)}`;
  const res = await lead.post('/api/events', {
    headers: ORIGIN,
    data: {
      slug,
      name: `TEST-L ${name} ${TAG}`,
      startsOn: today(-1),
      endsOn: today(1),
      posts: [{ label: 'Gate A' }, { label: 'Gate B' }],
      teams: [{ label: 'Rovers' }, { label: 'Medics', medical: true }],
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  let event = ((await res.json()) as { event: EventAdmin }).event;
  created.add(event.id);
  const pw = await lead.post(`/api/events/${event.id}/password`, { headers: ORIGIN, data: { password } });
  expect(pw.status(), await pw.text()).toBe(200);
  if (stage === 'live') {
    const live = await lead.post(`/api/events/${event.id}/go-live`, { headers: ORIGIN });
    expect(live.status(), await live.text()).toBe(200);
    event = ((await live.json()) as { event: EventAdmin }).event;
  }
  return { event, password };
}

async function stageOf(page: Page): Promise<string | null> {
  return page.getByTestId('event-setup').getAttribute('data-stage');
}

/** Adds a post / team / chip through its "+" sheet. */
async function addItem(page: Page, list: 'setup-posts' | 'setup-teams' | 'setup-last-seen', label: string, opts: { short?: string; medical?: boolean } = {}) {
  await page.getByTestId(`${list}-add`).click();
  await page.getByTestId('item-label').fill(label);
  if (opts.short) await page.getByTestId('item-short').fill(opts.short);
  if (opts.medical) await page.getByTestId('item-medical').click();
  await page.getByTestId('item-save').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test.afterAll(async ({ browser }) => {
  if (created.size === 0) return;
  const ctx = await leadContext(browser);
  try {
    for (const id of created) {
      const got = await ctx.request.get(`/api/events/${id}`);
      if (!got.ok()) continue;
      const { event } = (await got.json()) as { event: EventAdmin };
      await ctx.request.delete(`/api/events/${id}/password`, { headers: ORIGIN });
      await ctx.request.delete(`/api/events/${id}/join-link`, { headers: ORIGIN });
      if (event.stage === 'practice') await ctx.request.post(`/api/events/${id}/go-live`, { headers: ORIGIN });
      if (event.stage !== 'archived') await ctx.request.post(`/api/events/${id}/end`, { headers: ORIGIN });
    }
  } finally {
    await ctx.close();
  }
});

test('the whole journey with no developer: create, set up, practice, go live, end, reopen', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();

  // The lead signs in with the Ground Control passcode and lands on Events.
  await page.goto('/signin');
  await page.getByRole('textbox', { name: 'Your name' }).fill(`TEST-L Lead ${TAG}`);
  await page.getByRole('radio', { name: 'Dispatch' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Event password').fill(LEAD_PASSCODE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/events$/);
  await expect(page.getByTestId('events-screen')).toBeVisible();

  // New event: name (the link name follows it), two posts, three teams (one medical).
  await page.getByTestId('events-new').click();
  await expect(page).toHaveURL(/\/events\/new$/);
  const name = `TEST-L Journey ${TAG}`;
  await page.getByTestId('setup-name').fill(name);
  await expect(page.getByTestId('setup-slug')).toHaveValue(`test-l-journey-${TAG}`);
  await addItem(page, 'setup-posts', 'North Gate', { short: 'North' });
  await addItem(page, 'setup-posts', 'South Gate');
  await addItem(page, 'setup-teams', 'Rovers');
  await addItem(page, 'setup-teams', 'Dispatch desk');
  await addItem(page, 'setup-teams', 'Medics', { medical: true });
  await expect(page.getByTestId('setup-posts-chip')).toHaveText(['North GateNorth', 'South Gate']);
  await expect(page.getByRole('button', { name: 'Edit team Medics, the medical team' })).toBeVisible();
  await page.getByTestId('setup-create').click();
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').pop()!;
  created.add(id);
  expect(await stageOf(page)).toBe('practice');
  await expect(page.getByTestId('event-stage')).toHaveText('Practice');

  // Staff password: set, never shown back.
  await expect(page.getByTestId('password-state')).toContainText('—');
  await page.getByTestId('password-set').click();
  const password = secret('staff');
  await page.getByTestId('secret-input').fill(password);
  await page.getByTestId('secret-save').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('password-state')).toContainText('••••••••');
  await expect(page.getByText(password)).toHaveCount(0);

  // Join link: shown once, with Copy.
  await page.getByTestId('join-link-new').click();
  await expect(page.getByTestId('join-link-value')).toHaveValue(new RegExp(`/signin#join=test-l-journey-${TAG}\\.`));
  await expect(page.getByTestId('join-link-copy')).toBeVisible();
  const joinLink = decodeURIComponent(new URL(await page.getByTestId('join-link-value').inputValue()).hash.slice('#join='.length));

  // Staff sign in with the password and log a request in practice.
  const staff = await browser.newContext({ serviceWorkers: 'block' });
  expect(await staffSignIn(staff, password)).toBe(200);
  const practice = await logRequest(staff, 'North Gate', 'Practice');
  expect(practice.http).toBe(201);
  expect(practice.caseNumber).toBe(1);
  expect((await logRequest(staff, 'North Gate', 'Practice two')).caseNumber).toBe(2);

  // Go live: the sheet states what happens, with the practice count; afterwards the log is empty and numbering
  // restarts at LP-0001.
  await page.getByTestId('stage-go-live').click();
  const sheet = page.getByRole('dialog', { name: 'Go live' });
  await expect(sheet).toHaveAccessibleDescription('Practice requests are deleted and numbering restarts at LP-0001.');
  await expect(sheet.getByTestId('sheet-practice-deleted')).toHaveText('Deleted');
  await expect(sheet.getByTestId('sheet-practice-count')).toHaveText('2');
  await expect(sheet).toContainText('LP-0001');
  await sheet.getByTestId('stage-confirm').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('event-stage')).toHaveText('Live');
  const rows = (await (await staff.request.get('/api/sync')).json()) as { rows: RequestSummary[] };
  expect(rows.rows).toEqual([]);
  const first = await logRequest(staff, 'South Gate', 'Live');
  expect(first.http).toBe(201);
  expect(first.caseNumber).toBe(1);
  // A fresh staff phone sees the live log only: LP-0001, no practice request.
  const phone = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  expect(await staffSignIn(phone.context(), password)).toBe(200);
  const listed = (await (await phone.request.get('/api/sync')).json()) as { rows: RequestSummary[] };
  expect(listed.rows.map((r) => r.caseNumber)).toEqual([1]);
  await phone.context().close();

  // End event: staff are refused from then on; nothing is deleted.
  await page.getByTestId('stage-end').click();
  const end = page.getByRole('dialog', { name: 'End event' });
  // No sentence on screen: rows and chips; the sentence is the sheet's description.
  await expect(end).toHaveAccessibleDescription('Staff are signed out and nothing is deleted; within 24 hours it can be reopened with the same password and join link.');
  await expect(end.getByTestId('end-staff')).toContainText('Signed out');
  await expect(end.getByTestId('end-records')).toContainText('Kept');
  await expect(end.getByTestId('end-password')).toContainText('Kept 24 h');
  await expect(end.getByTestId('end-join-link')).toContainText('Kept 24 h');
  await end.getByTestId('stage-confirm').click();
  await expect(end).toHaveCount(0);
  await expect(page.getByTestId('event-stage')).toHaveText('Archived');
  expect((await staff.request.get('/api/sync')).status()).toBe(410);
  // (Grace period) For 24 h the end keeps the staff password and join link: both answer Ended (410), nobody signs in.
  const late = await browser.newContext({ serviceWorkers: 'block' });
  expect(await staffSignIn(late, password)).toBe(410);
  expect(await staffJoin(late, joinLink)).toBe(410);
  await late.close();
  const leadRows = await page.request.get(`/api/events`);
  const ended = ((await leadRows.json()) as { events: EventAdmin[] }).events.find((e) => e.id === id)!;
  expect(ended.requests).toBe(1);

  // Archived: the settings its records were made with are read-only; Reopen instead of the password.
  await expect(page.getByTestId('setup-posts-add')).toHaveCount(0);
  await expect(page.getByTestId('password-set')).toHaveCount(0);

  // Reopen right away (inside the 24 h): the password and join link are kept; staff sign in with them again. Then the
  // lead changes the password; the old one no longer works.
  await page.getByTestId('stage-reopen').click();
  const reopen = page.getByRole('dialog', { name: 'Reopen' });
  await expect(reopen).toHaveAccessibleDescription('Open requests resume as they were; staff sign in again.');
  await expect(reopen.getByTestId('reopen-staff')).toContainText('Sign in again');
  await expect(reopen.getByTestId('reopen-open')).toContainText(/^\d+$/);
  await expect(reopen.getByTestId('reopen-password')).toContainText('Kept');
  await expect(reopen.getByTestId('reopen-join-link')).toContainText('Kept');
  await reopen.getByTestId('stage-confirm').click();
  await expect(reopen).toHaveCount(0);
  await expect(page.getByTestId('event-stage')).toHaveText('Live');
  await expect(page.getByTestId('password-state')).toContainText('••••••••');
  await expect(page.getByTestId('join-link-state')).not.toContainText('—');
  expect(await staffSignIn(staff, password)).toBe(200);
  expect(await staffJoin(staff, joinLink)).toBe(200);
  await page.getByTestId('password-set').click();
  const second = secret('again');
  await page.getByTestId('secret-input').fill(second);
  await page.getByTestId('secret-save').click();
  // The sheet closes once the change is saved (the row showed dots before it too).
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('password-state')).toContainText('••••••••');
  expect(await staffSignIn(staff, second)).toBe(200);
  expect(await staffSignIn(staff, password)).toBe(401);

  await staff.close();
  await page.context().close();
});

test('two events live at once: the lead switches between them from the desk switcher', async ({ browser }) => {
  test.setTimeout(120_000);
  const lead = await leadContext(browser, { viewport: DESK });
  const a = await apiEvent(lead.request, 'Alpha', 'live');
  const b = await apiEvent(lead.request, 'Bravo', 'live');
  const staffA = await browser.newContext({ serviceWorkers: 'block' });
  const staffB = await browser.newContext({ serviceWorkers: 'block' });
  expect(await staffSignIn(staffA, a.password)).toBe(200);
  expect(await staffSignIn(staffB, b.password)).toBe(200);
  const ra = await logRequest(staffA, 'Gate A', 'Alpha one');
  const rb = await logRequest(staffB, 'Gate B', 'Bravo one');
  expect([ra.caseNumber, rb.caseNumber]).toEqual([1, 1]);

  const page = await lead.newPage();
  await page.goto('/events');
  await page.locator(`[data-testid="event-row"][data-slug="${a.event.slug}"] button`).click();
  await expect(page).toHaveURL(`${BASE}/`);
  const switcher = page.getByTestId('event-switcher');
  await expect(switcher).toContainText(a.event.name);
  await expect(page.getByTestId('desk-event')).toHaveAttribute('href', `/events/${a.event.id}?from=app`);
  let ids = ((await (await page.request.get('/api/sync')).json()) as { rows: RequestSummary[] }).rows.map((r) => r.id);
  expect(ids).toEqual([ra.id]);

  await switcher.click();
  const menu = page.getByTestId('event-switcher-menu');
  await expect(menu.locator(`[data-slug="${a.event.slug}"]`)).toContainText('Live');
  await expect(menu.locator(`[data-slug="${a.event.slug}"]`).getByLabel('Open now')).toBeVisible();
  await menu.locator(`[data-slug="${b.event.slug}"]`).click();
  await expect(page.getByTestId('event-switcher')).toContainText(b.event.name);
  ids = ((await (await page.request.get('/api/sync')).json()) as { rows: RequestSummary[] }).rows.map((r) => r.id);
  expect(ids).toEqual([rb.id]);
  // Both stay live for their own staff.
  expect((await staffA.request.get('/api/sync')).status()).toBe(200);
  expect((await staffB.request.get('/api/sync')).status()).toBe(200);

  // The "Event" item opens setup for the open event, and Back returns to the log.
  await page.getByTestId('desk-event').click();
  await expect(page).toHaveURL(new RegExp(`/events/${b.event.id}\\?from=app$`));
  await expect(page.getByTestId('setup-name')).toHaveValue(b.event.name);
  await page.getByTestId('setup-back').click();
  await expect(page).toHaveURL(`${BASE}/`);

  await Promise.all([staffA.close(), staffB.close(), lead.close()]);
});

test('server field errors show next to their field', async ({ browser }) => {
  test.setTimeout(120_000);
  const lead = await leadContext(browser);
  const other = await apiEvent(lead.request, 'Taken', 'practice');
  const used = await apiEvent(lead.request, 'In use', 'live');
  const page = await lead.newPage();

  // The form's own check, then a duplicate link name (409, field slug).
  await page.goto('/events/new');
  await page.getByTestId('setup-create').click();
  await expect(page.locator('#setup-err-name')).toHaveText('Required');
  await expect(page.getByTestId('setup-name')).toBeFocused();
  await page.getByTestId('setup-name').fill(`TEST-L Dup ${TAG}`);
  await page.getByTestId('setup-slug').fill(other.event.slug);
  await page.getByTestId('setup-create').click();
  await expect(page.locator('#setup-err-slug')).toHaveText('That link name is taken');
  await expect(page.getByTestId('setup-slug')).toHaveAttribute('aria-invalid', 'true');

  // A staff password that is another running event's (422 invalid, field password).
  await page.goto(`/events/${used.event.id}`);
  await page.getByTestId('password-set').click();
  await page.getByTestId('secret-input').fill(other.password);
  await page.getByTestId('secret-save').click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Choose a different password');
  await expect(page.getByTestId('secret-input')).toHaveAttribute('aria-invalid', 'true');
  // …and the lead passcode itself.
  await page.getByTestId('secret-input').fill(LEAD_PASSCODE);
  await page.getByTestId('secret-save').click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Choose a different password');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // A post still in use by a request (422 in_use, field posts).
  const staff = await browser.newContext({ serviceWorkers: 'block' });
  expect(await staffSignIn(staff, used.password)).toBe(200);
  expect((await logRequest(staff, 'Gate A', 'Uses gate A')).http).toBe(201);
  await page.getByRole('button', { name: 'Remove post Gate A' }).click();
  await page.getByTestId('setup-save').click();
  await expect(page.locator('#setup-err-posts')).toHaveText('Still used by requests');
  await page.getByTestId('setup-discard').click();
  await expect(page.getByRole('button', { name: 'Remove post Gate A' })).toBeVisible();

  // Settings frozen once the event ended in the meantime (409 bad_stage, field posts).
  expect((await lead.request.post(`/api/events/${used.event.id}/end`, { headers: ORIGIN })).status()).toBe(200);
  await page.getByRole('button', { name: 'Remove post Gate B' }).click();
  await page.getByTestId('setup-save').click();
  await expect(page.locator('#setup-err-posts')).toHaveText('Not possible at this stage');
  // Reloaded, the archived event's settings are read-only instead.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Remove post Gate B' })).toHaveCount(0);

  await Promise.all([staff.close(), lead.close()]);
});

test('an archived event: setup is read-only where its records were made with it', async ({ browser }) => {
  const lead = await leadContext(browser);
  const { event } = await apiEvent(lead.request, 'Archive', 'live');
  expect((await lead.request.post(`/api/events/${event.id}/end`, { headers: ORIGIN })).status()).toBe(200);
  const page = await lead.newPage();
  await page.goto(`/events/${event.id}`);
  await expect(page.getByTestId('event-stage')).toHaveText('Archived');
  for (const list of ['setup-posts', 'setup-teams', 'setup-last-seen']) await expect(page.getByTestId(`${list}-add`)).toHaveCount(0);
  await expect(page.getByTestId('setup-posts-chip')).toHaveText(['Gate A', 'Gate B']);
  await expect(page.getByRole('button', { name: /^Remove post/ })).toHaveCount(0);
  await expect(page.getByTestId('setup-dates').getByRole('button')).toHaveCount(0);
  await expect(page.getByTestId('setup-tz')).toHaveCount(0);
  await expect(page.getByTestId('setup-day')).toHaveCount(0);
  await expect(page.getByTestId('setup-main-medical')).toHaveAttribute('readonly', '');
  await expect(page.getByTestId('password-set')).toHaveCount(0);
  await expect(page.getByTestId('stage-reopen')).toBeVisible();
  // The name and the report's lines stay editable (the report is written after the end).
  await page.getByTestId('setup-department').fill('Ground Control');
  await page.getByTestId('setup-save').click();
  await expect(page.getByTestId('stage-reopen')).toBeVisible();
  const saved = (await (await lead.request.get(`/api/events/${event.id}`)).json()) as { event: EventAdmin };
  expect(saved.event.department).toBe('Ground Control');
  expect(saved.event.posts.map((p) => p.label)).toEqual(['Gate A', 'Gate B']);
  await lead.close();
});

test('staff can open no lead screen by URL, and the lead routes refuse them', async ({ browser }) => {
  const staff = await newSignedInContext(browser, { staffName: `TEST-L Floor ${TAG}`, team: 'GC/HX - Dispatch' });
  const page = await staff.newPage();
  for (const path of ['/events', '/events/new', `/events/${TEST_EVENT_ID}`, `/events/${TEST_EVENT_ID}?from=app`]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(`${BASE}/`);
  }
  await expect(page.getByTestId('desk-event')).toHaveCount(0);
  await page.getByTestId('account-trigger').first().click();
  await expect(page.getByTestId('lead-events-item')).toHaveCount(0);
  await expect(page.getByTestId('lead-event-item')).toHaveCount(0);
  expect((await staff.request.get('/api/events')).status()).toBe(403);
  expect((await staff.request.post('/api/events', { headers: ORIGIN, data: { slug: `t-l-${TAG}-x`, name: 'x', startsOn: today(), endsOn: today() } })).status()).toBe(403);
  expect((await staff.request.post('/api/org/lead-passcode', { headers: ORIGIN, data: { passcode: secret('nope') } })).status()).toBe(403);
  // No lead screen code was loaded for staff.
  const scripts = await page.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name));
  expect(scripts.filter((s) => /EventsScreen|SetupScreen|EventSwitcher/.test(s))).toEqual([]);
  await staff.close();
});

test('without a session the lead pages go to sign-in and come back', async ({ browser }) => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto('/events');
  await expect(page).toHaveURL(/\/signin\?next=(%2F|\/)events$/);
  await ctx.close();
});

test('a lead with no event open is sent from the log to Events; the account menu reaches Events and Event', async ({ browser }) => {
  const lead = await leadContext(browser);
  const page = await lead.newPage();
  await page.goto('/');
  await expect(page).toHaveURL(/\/events$/);
  await expect(page.getByTestId('events-screen')).toBeVisible();
  // Opening the local test event: the log, with the lead's Event and Events rows in the account menu (phone).
  await page.locator(`[data-testid="event-row"][data-slug="local"] button`).click();
  await expect(page).toHaveURL(`${BASE}/`);
  await page.getByTestId('account-trigger').first().click();
  await expect(page.getByTestId('lead-event-item')).toHaveAttribute('href', `/events/${TEST_EVENT_ID}?from=app`);
  await page.getByTestId('lead-events-item').click();
  await expect(page).toHaveURL(/\/events$/);
  await lead.close();
});

test('the lead passcode changes from Events; the lead stays signed in, the old passcode stops working', async ({ browser }) => {
  test.setTimeout(120_000);
  const lead = await leadContext(browser);
  const page = await lead.newPage();
  const fresh = secret('lead');
  try {
    await page.goto('/events');
    // A poll in flight while the passcode changes (the list re-read at the same moment).
    await page.getByTestId('lead-account').click();
    await page.getByTestId('lead-passcode').click();
    await page.getByTestId('secret-input').fill('short');
    await page.getByTestId('secret-save').click();
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('At least 8 characters');
    await page.getByTestId('secret-input').fill(fresh);
    const racing = page.evaluate(() => Promise.all(Array.from({ length: 4 }, () => fetch('/api/events').then((r) => r.status))));
    await page.getByTestId('secret-save').click();
    await racing;
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Still signed in: the list loads after a reload.
    await page.reload();
    await expect(page.getByTestId('events-screen')).toBeVisible();
    await expect(page.getByTestId('event-row').first()).toBeVisible();
    const api = lead.request;
    expect(await staffSignIn(api, LEAD_PASSCODE)).toBe(401);
    expect(await staffSignIn(api, fresh)).toBe(200);
  } finally {
    // Back to the env's passcode (other files sign in with it); their cached lead cookies are signed out by now.
    const res = await lead.request.post('/api/org/lead-passcode', { headers: ORIGIN, data: { passcode: LEAD_PASSCODE } });
    expect(res.status(), await res.text()).toBe(200);
    forgetSignedInStates();
    await lead.close();
  }
});

test('lead screens pass axe in both themes', async ({ browser }) => {
  test.setTimeout(120_000);
  const lead = await leadContext(browser);
  const { event } = await apiEvent(lead.request, 'Axe', 'practice');
  for (const scheme of ['light', 'dark'] as const) {
    const page = await lead.newPage();
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/events');
    await expect(page.getByTestId('event-row').first()).toBeVisible();
    expect((await axeViolations(page)).map((f) => `${scheme} events ${f.rule} ${f.target} ${f.summary}`)).toEqual([]);
    await page.goto(`/events/${event.id}`);
    await expect(page.getByTestId('setup-name')).toHaveValue(event.name);
    expect((await axeViolations(page)).map((f) => `${scheme} setup ${f.rule} ${f.target} ${f.summary}`)).toEqual([]);
    await page.getByTestId('stage-go-live').click();
    await expect(page.getByRole('dialog', { name: 'Go live' })).toBeVisible();
    expect((await axeViolations(page)).map((f) => `${scheme} go-live ${f.rule} ${f.target} ${f.summary}`)).toEqual([]);
    await page.close();
  }
  await lead.close();
});
