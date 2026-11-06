import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { CreateResponse, ChangeResponse, RequestDetail, RequestSummary } from '../../lib/api-types';
import { axeViolations, smallTargets } from './helpers/a11y';
import { newSignedInContext, signedInAs } from './helpers/session';

// Profile (spec §8 Profile, §9.4): answer, change answer (its menu: the other answer or Back to Waiting for
// check, DECISIONS v2.2), Undo for 10 s on every answer, Reunited, Discharged and Reopen from the profile;
// cancel (creator only, with the confirm) and reopen; edits in the audit trail with old → new; photos and the
// full-screen viewer; another person's change while it is open; offline disables actions.
// Runs at integration against the real store and API (`npm run build:test`, then PORT=… npm run test:e2e).
// Synthetic data only: every row is named TEST-P-… and is closed again after each test.

const FRONT = { staffName: 'TEST-P Front', team: 'GC/HX - Dispatch' };
const LIAISON = { staffName: 'TEST-P Liaison', team: 'Medical' };

// Every test's own page is front of house, signed in once through POST /api/session (A17).
signedInAs(FRONT);

// A valid 1×1 JPEG (synthetic): passes the server's magic-byte sniffing and decodes in the browser.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

const unique = () => `TEST-P-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function api<T>(request: APIRequestContext, origin: string, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: { Origin: origin } });
  expect(res.ok(), `${method} ${path} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

interface Staff {
  staffName: string;
  team: string;
}

/** A second signed-in person in their own browser context (signed in through POST /api/session). */
async function otherPerson(browser: Browser, staff: Staff, baseURL: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await newSignedInContext(browser, staff, { baseURL, viewport: { width: 390, height: 844 } });
  return { context, page: await context.newPage() };
}

const created: Array<{ id: string; request: APIRequestContext }> = [];

async function createRequest(page: Page, origin: string, fields: Record<string, unknown> = {}): Promise<RequestSummary> {
  const body = {
    clientMutationId: randomUUID(),
    reportingLocation: 'FA 3 – Kinetic',
    name: `${unique()} Kayla`,
    age: 19,
    gender: 'Female',
    clothing: 'Pink cowboy hat, silver fringe top',
    lastSeen: 'kineticFIELD rail',
    contactName: 'Maya R.',
    contactPhone: '(407) 555-0142',
    contactRelationship: 'Best friend',
    ...fields,
  };
  const { request } = await api<CreateResponse>(page.request, origin, 'POST', '/api/requests', body);
  created.push({ id: request.id, request: page.request });
  return request;
}

async function setStatus(page: Page, origin: string, row: RequestSummary, status: string, kind: string): Promise<RequestSummary> {
  const { request } = await api<ChangeResponse>(page.request, origin, 'POST', `/api/requests/${row.id}/status`, {
    status,
    expectedVersion: row.rowVersion,
    kind,
  });
  return request;
}

const statusBlock = (page: Page) => page.getByTestId('status-block');
const changeAnswer = (page: Page) => page.getByTestId('profile-actions').getByRole('button', { name: 'Change answer' });
const undoButton = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true });
/** Let the menu's open animation (a slight scale-in) finish before measuring it. */
const settle = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
/** Change answer → one of its menu choices ("Not in medical", "In medical", "Back to Waiting for check"). */
async function chooseChange(page: Page, choice: string) {
  await changeAnswer(page).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: choice, exact: true }).click();
  await expect(menu).toBeHidden();
}
const profileStatus = (page: Page, status: string) => page.locator(`[data-testid="profile"][data-status="${status}"]`);
const auditItems = (page: Page) => page.getByTestId('audit-item');

test.afterEach(async ({ baseURL }) => {
  // Close what the test left open, so other specs' counts stay meaningful.
  const origin = baseURL as string;
  for (const { id, request } of created.splice(0)) {
    try {
      const row = await api<RequestDetail>(request, origin, 'GET', `/api/requests/${id}`);
      if (row.status === 'Added') {
        await request.fetch(`/api/requests/${id}/cancel`, { method: 'POST', data: { expectedVersion: row.rowVersion }, headers: { Origin: origin } });
      } else if (row.status === 'Found – Awaiting Reunion' || row.status === 'Checked – Not Found') {
        const status = row.status === 'Checked – Not Found' ? 'Found – Awaiting Reunion' : 'Reunited – Closed';
        const kind = row.status === 'Checked – Not Found' ? 'change' : 'reunite';
        const res = await request.fetch(`/api/requests/${id}/status`, { method: 'POST', data: { status, expectedVersion: row.rowVersion, kind }, headers: { Origin: origin } });
        if (res.ok() && status !== 'Reunited – Closed') {
          const next = ((await res.json()) as ChangeResponse).request;
          await request.fetch(`/api/requests/${id}/status`, { method: 'POST', data: { status: 'Reunited – Closed', expectedVersion: next.rowVersion, kind: 'reunite' }, headers: { Origin: origin } });
        }
      }
    } catch {
      // Best effort.
    }
  }
});

test('renders from the request, answers, changes the answer, reunites, reopens and discharges', async ({ page, baseURL }) => {
  const origin = baseURL as string;
  const row = await createRequest(page, origin, { hair: 'Blond, two braids' });

  await page.goto(`/?r=${row.id}`);
  await expect(page.getByRole('heading', { level: 1, name: row.name })).toBeVisible();
  await expect(page.getByText('19 · Female')).toBeVisible();
  await expect(page.getByText(`FA 3 – Kinetic · ${FRONT.staffName}`)).toBeVisible();
  await expect(statusBlock(page)).toContainText('Waiting for check');
  await expect(statusBlock(page)).toContainText('Logged');
  await expect(page.getByTestId('wait-badge')).toBeVisible();
  // Filled fields only.
  const person = page.getByTestId('person-details');
  await expect(person).toContainText('Wearing');
  await expect(person).toContainText('Last seen');
  await expect(person).toContainText('Hair');
  await expect(person).not.toContainText('Build');
  await expect(page.getByTestId('friend-details')).toContainText('Maya R. · Best friend');
  await expect(page.getByRole('link', { name: /^Call / })).toHaveAttribute('href', 'tel:4075550142');
  // Audit trail: logged, with the post and who.
  await expect(auditItems(page).first()).toContainText('Request logged');
  await expect(auditItems(page).first()).toContainText('FA 3 – Kinetic');
  await expect(auditItems(page).first()).toContainText(`${FRONT.staffName} · Dispatch`);

  // Waiting → In medical.
  await page.getByRole('button', { name: 'In medical', exact: true }).click();
  await expect(profileStatus(page, 'Found – Awaiting Reunion')).toBeVisible();
  await expect(statusBlock(page)).toContainText('In medical · friend coming');
  // Who answered and when, then where medical has them (Pending v8): no "heading to Main Med" line.
  await expect(statusBlock(page)).not.toContainText('heading');
  await expect(statusBlock(page).getByTestId('location-row')).toHaveAccessibleName('Add location');
  await expect(auditItems(page).first()).toContainText('Waiting for check');
  await expect(auditItems(page).first()).toContainText('In medical');
  await expect(auditItems(page).first()).toContainText(`${FRONT.staffName} · Dispatch`);

  // Change answer → Not in medical → Change answer → In medical.
  await chooseChange(page, 'Not in medical');
  await expect(profileStatus(page, 'Checked – Not Found')).toBeVisible();
  await expect(statusBlock(page)).toContainText(FRONT.staffName);
  await chooseChange(page, 'In medical');
  await expect(profileStatus(page, 'Found – Awaiting Reunion')).toBeVisible();

  // Reunited closes it: no actions.
  await page.getByRole('button', { name: 'Reunited', exact: true }).click();
  await expect(profileStatus(page, 'Reunited – Closed')).toBeVisible();
  await expect(page.getByTestId('profile-actions')).toHaveCount(0);

  // ⋯ Reopen (→ In medical), then ⋯ Mark discharged.
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Reopen' }).click();
  await expect(profileStatus(page, 'Found – Awaiting Reunion')).toBeVisible();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Mark discharged' }).click();
  await expect(profileStatus(page, 'Found – Discharged')).toBeVisible();
  await expect(statusBlock(page)).toContainText('Discharged');
});

test('Not in medical is closed and grey, and keeps exactly its actions: Change answer only', async ({ browser, page, baseURL }) => {
  // v2.2 (Jeffrey, 2026-11-06): Not in medical counts as closed and is greyed out like Reunited, but it is
  // still answerable — no Reopen, no Mark discharged, no Cancel request (not even for the person who logged it).
  const origin = baseURL as string;
  const row = await createRequest(page, origin);
  await page.goto(`/?r=${row.id}`);
  await page.getByRole('button', { name: 'Not in medical', exact: true }).click();
  await expect(profileStatus(page, 'Checked – Not Found')).toBeVisible();

  // Grey like the other closed states: grey tint, grey label, grey × glyph.
  await expect(statusBlock(page)).toHaveAttribute('data-tone', 'gray');
  await expect(statusBlock(page).locator('[data-accent-color="gray"]', { hasText: 'Not in medical' })).toBeVisible();
  await expect(statusBlock(page).locator('svg[data-glyph="notInMedical"] circle')).toHaveAttribute('fill', 'var(--gray-9)');
  const tint = await statusBlock(page).evaluate((el) => getComputedStyle(el).backgroundColor);
  // The audit trail's newest entry: the grey glyph on the timeline and in "Waiting for check → Not in medical".
  const latest = auditItems(page).first();
  await expect(latest).toContainText('Not in medical');
  await expect(latest.locator('svg[data-glyph="notInMedical"] circle')).toHaveCount(2);
  for (const circle of await latest.locator('svg[data-glyph="notInMedical"] circle').all()) await expect(circle).toHaveAttribute('fill', 'var(--gray-9)');
  await expect(latest.locator('[data-accent-color="gray"]', { hasText: 'Not in medical' })).toBeVisible();

  // Exactly one action: Change answer (its menu: In medical, Back to Waiting for check).
  const bar = page.getByTestId('profile-actions');
  await expect(bar.getByRole('button')).toHaveCount(1);
  await expect(changeAnswer(page)).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Reunited', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel request' })).toHaveCount(0);
  // ⋯ holds Edit details only.
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Edit details' })).toBeVisible();
  await expect(page.getByRole('menuitem')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // Someone else sees the same: Change answer, no Reopen.
  const liaison = await otherPerson(browser, LIAISON, origin);
  await liaison.page.goto(`/?r=${row.id}`);
  await expect(statusBlock(liaison.page)).toHaveAttribute('data-tone', 'gray');
  await expect(liaison.page.getByTestId('profile-actions').getByRole('button')).toHaveCount(1);
  await liaison.page.getByRole('button', { name: 'More actions' }).click();
  await expect(liaison.page.getByRole('menuitem')).toHaveCount(1);
  await liaison.context.close();

  // The same grey tint as Reunited's block.
  const reunitedRow = await createRequest(page, origin);
  const inMedical = await setStatus(page, origin, reunitedRow, 'Found – Awaiting Reunion', 'answer');
  await setStatus(page, origin, inMedical, 'Reunited – Closed', 'reunite');
  await page.goto(`/?r=${reunitedRow.id}`);
  await expect(profileStatus(page, 'Reunited – Closed')).toBeVisible();
  expect(await statusBlock(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(tint);

  // And Change answer still works.
  await page.goto(`/?r=${row.id}`);
  await chooseChange(page, 'In medical');
  await expect(profileStatus(page, 'Found – Awaiting Reunion')).toBeVisible();
  await expect(statusBlock(page)).toHaveAttribute('data-tone', 'green');
});

test('Change answer opens a menu: the other answer or Back to Waiting for check, each saved on tap with Undo', async ({ page, baseURL }) => {
  // DECISIONS v2.2 (Brian + Jeffrey, 2026-11-06): "if someone accidentally sets an in medical state then it's
  // easy to undo and also set back to pending".
  const origin = baseURL as string;
  const row = await createRequest(page, origin);
  await page.goto(`/?r=${row.id}`);
  const lp = await page.getByTestId('profile-case').innerText();

  // Waiting → In medical from the profile button: Undo is offered.
  await page.getByRole('button', { name: 'In medical', exact: true }).click();
  await expect(profileStatus(page, 'Found – Awaiting Reunion')).toBeVisible();
  await expect(page.getByText(`${lp} · In medical`)).toBeVisible();
  await expect(undoButton(page)).toBeVisible();

  // The menu: the other answer, a separator, Back to Waiting for check; each marked with its status glyph.
  await changeAnswer(page).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  // (The open menu is modal: the page behind it, the button included, is aria-hidden until it closes.)
  await expect(page.getByTestId('change-answer')).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('menuitem')).toHaveText(['Not in medical', 'Back to Waiting for check']);
  await expect(menu.getByRole('menuitem', { name: 'Not in medical' }).locator('svg[data-glyph="notInMedical"]')).toHaveCount(1);
  await expect(menu.getByRole('menuitem', { name: 'Back to Waiting for check' }).locator('svg[data-glyph="waiting"]')).toHaveCount(1);
  // 44 px rows (axe on the open menu: the describe block below).
  await settle(page);
  expect(await smallTargets(page, '[role="menu"]')).toEqual([]);

  // In medical → Back to Waiting for check: saved on tap, audited as a change, with Undo.
  await menu.getByRole('menuitem', { name: 'Back to Waiting for check' }).click();
  await expect(menu).toBeHidden();
  await expect(profileStatus(page, 'Added')).toBeVisible();
  await expect(statusBlock(page)).toContainText('Waiting for check');
  await expect(page.getByTestId('wait-badge')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Not in medical', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'In medical', exact: true })).toBeEnabled();
  await expect(auditItems(page).first()).toContainText('In medical');
  await expect(auditItems(page).first()).toContainText('Waiting for check');
  await expect(auditItems(page).first()).toContainText(`${FRONT.staffName} · Dispatch`);
  await expect(page.getByText(`${lp} · Waiting for check`)).toBeVisible();

  // Undo stays for 10 s (it was 6 s): still there after 7 s, and it puts the answer back.
  await page.waitForTimeout(7_000);
  await expect(undoButton(page)).toBeVisible();
  await undoButton(page).click();
  await expect(profileStatus(page, 'Found – Awaiting Reunion')).toBeVisible();
  await expect(auditItems(page).first()).toContainText('Undo');
  await expect(undoButton(page)).toHaveCount(0);

  // In medical → Not in medical through the menu: Undo offered.
  await chooseChange(page, 'Not in medical');
  await expect(profileStatus(page, 'Checked – Not Found')).toBeVisible();
  await expect(page.getByText(`${lp} · Not in medical`)).toBeVisible();
  await expect(undoButton(page)).toBeVisible();

  // Not in medical (closed, grey) → its menu: In medical, then Back to Waiting for check.
  await changeAnswer(page).click();
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['In medical', 'Back to Waiting for check']);
  await page.getByRole('menuitem', { name: 'Back to Waiting for check' }).click();
  await expect(profileStatus(page, 'Added')).toBeVisible();
  await expect(page.getByText(`${lp} · Waiting for check`)).toBeVisible();
  await expect(auditItems(page).first()).toContainText('Not in medical');
  await expect(auditItems(page).first()).toContainText('Waiting for check');
  await undoButton(page).click();
  await expect(profileStatus(page, 'Checked – Not Found')).toBeVisible();

  // Not in medical → In medical through the menu, then Reunited: both offer Undo.
  await chooseChange(page, 'In medical');
  await expect(profileStatus(page, 'Found – Awaiting Reunion')).toBeVisible();
  await expect(undoButton(page)).toBeVisible();
  await page.getByRole('button', { name: 'Reunited', exact: true }).click();
  await expect(profileStatus(page, 'Reunited – Closed')).toBeVisible();
  await expect(page.getByText(`${lp} · Reunited`)).toBeVisible();
  await undoButton(page).click();
  await expect(profileStatus(page, 'Found – Awaiting Reunion')).toBeVisible();

  // The server kept every move: the audit trail holds each change and each Undo.
  const detail = await api<RequestDetail>(page.request, origin, 'GET', `/api/requests/${row.id}`);
  const moves = detail.audit.filter((e) => e.action === 'status').map((e) => `${e.previous.status} → ${e.next.status} (${e.next.kind})`);
  expect(moves).toEqual([
    'Added → Found – Awaiting Reunion (answer)',
    'Found – Awaiting Reunion → Added (change)',
    'Added → Found – Awaiting Reunion (undo)',
    'Found – Awaiting Reunion → Checked – Not Found (change)',
    'Checked – Not Found → Added (change)',
    'Added → Checked – Not Found (undo)',
    'Checked – Not Found → Found – Awaiting Reunion (change)',
    'Found – Awaiting Reunion → Reunited – Closed (reunite)',
    'Reunited – Closed → Found – Awaiting Reunion (undo)',
  ]);
});

test.describe('the Change answer menu passes axe', () => {
  // axe-core is injected as a script, which the production CSP (rightly) refuses: this block bypasses it.
  test.use({ bypassCSP: true, serviceWorkers: 'block' });
  for (const theme of ['light', 'dark'] as const) {
    test(`open, in the ${theme} theme`, async ({ page, baseURL }) => {
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('lp-theme', t);
        } catch {
          // ignore
        }
      }, theme);
      const origin = baseURL as string;
      const row = await createRequest(page, origin);
      const inMedical = await setStatus(page, origin, row, 'Found – Awaiting Reunion', 'answer');
      await page.goto(`/?r=${inMedical.id}`);
      await expect(profileStatus(page, 'Found – Awaiting Reunion')).toBeVisible();
      await expect(auditItems(page).first()).toBeVisible();
      await changeAnswer(page).click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await page.waitForTimeout(300);
      await settle(page);
      // A modal Radix menu marks the page behind it aria-hidden and keeps focus inside itself (the ⋯ menu
      // has done the same since Phase 2): axe's aria-hidden-focus on that page root is the only finding it may
      // make, and Tab never takes focus out of the menu, so nothing aria-hidden can be reached. The page root
      // is the profile's, or the desk frame's that wraps every view (a plain block on the phone).
      const findings = (await axeViolations(page)).filter((v) => !(v.rule === 'aria-hidden-focus' && /_(app|frame)$/.test(v.target)));
      expect(findings).toEqual([]);
      for (let i = 0; i < 3; i += 1) {
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => !!document.activeElement?.closest('[role="menu"]'))).toBe(true);
      }
      expect(await smallTargets(page, '[role="menu"]')).toEqual([]);
    });
  }
});

test('the Not in medical button on the profile offers Undo too', async ({ page, baseURL }) => {
  const origin = baseURL as string;
  const row = await createRequest(page, origin);
  await page.goto(`/?r=${row.id}`);
  const lp = await page.getByTestId('profile-case').innerText();
  await page.getByRole('button', { name: 'Not in medical', exact: true }).click();
  await expect(profileStatus(page, 'Checked – Not Found')).toBeVisible();
  await expect(page.getByText(`${lp} · Not in medical`)).toBeVisible();
  await undoButton(page).click();
  await expect(profileStatus(page, 'Added')).toBeVisible();
  await expect(auditItems(page).first()).toContainText('Undo');
});

test('cancel is creator-only, asks once (Keep / Cancel request), and the creator can reopen', async ({ browser, page, baseURL }) => {
  const origin = baseURL as string;
  const row = await createRequest(page, origin);

  // Someone else: no Cancel anywhere.
  const liaison = await otherPerson(browser, LIAISON, origin);
  await liaison.page.goto(`/?r=${row.id}`);
  await expect(statusBlock(liaison.page)).toContainText('Waiting for check');
  await expect(liaison.page.getByRole('button', { name: 'Cancel request' })).toHaveCount(0);
  await liaison.page.getByRole('button', { name: 'More actions' }).click();
  await expect(liaison.page.getByRole('menuitem', { name: 'Edit details' })).toBeVisible();
  await expect(liaison.page.getByRole('menuitem', { name: 'Cancel request' })).toHaveCount(0);
  await liaison.context.close();

  // The creator.
  await page.goto(`/?r=${row.id}`);
  await page.getByRole('button', { name: 'Cancel request' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Cancel this request?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(row.name);
  await dialog.getByRole('button', { name: 'Keep' }).click();
  await expect(dialog).toBeHidden();
  await expect(profileStatus(page, 'Added')).toBeVisible();

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Cancel request' }).click();
  await dialog.getByRole('button', { name: 'Cancel request' }).click();
  await expect(dialog).toBeHidden();
  await expect(profileStatus(page, 'Cancelled')).toBeVisible();
  await expect(page.getByTestId('profile-actions')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel request' })).toHaveCount(0);
  await expect(auditItems(page).first()).toContainText('Cancelled');

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Reopen' }).click();
  await expect(profileStatus(page, 'Added')).toBeVisible();
  await expect(auditItems(page).first()).toContainText('Reopened');
});

test('edits show in the audit trail as old (struck) → new, and Edit opens the right section', async ({ page, baseURL }) => {
  const origin = baseURL as string;
  const row = await createRequest(page, origin);
  const newName = `${row.name} Lee`;
  await api<ChangeResponse>(page.request, origin, 'PATCH', `/api/requests/${row.id}`, {
    patch: { name: newName, hair: 'Blond, two braids' },
    expectedVersion: row.rowVersion,
  });

  await page.goto(`/?r=${row.id}`);
  await expect(page.getByRole('heading', { level: 1, name: newName })).toBeVisible();
  const edit = auditItems(page).first();
  await expect(edit).toContainText('Edited Name, Hair');
  await expect(edit.locator('s').first()).toHaveText(row.name);
  await expect(edit).toContainText(newName);
  await expect(edit.locator('s').nth(1)).toHaveText('—');
  await expect(edit).toContainText('Blond, two braids');

  await page.getByRole('button', { name: 'Edit missing person' }).click();
  await expect(page).toHaveURL(new RegExp(`\\?r=${row.id}&edit=person$`));
  await page.goBack();
  await page.getByRole('button', { name: 'Edit friend or family' }).click();
  await expect(page).toHaveURL(new RegExp(`\\?r=${row.id}&edit=friend$`));
  await page.goBack();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit details' }).click();
  await expect(page).toHaveURL(new RegExp(`\\?r=${row.id}&edit=all$`));
});

test('photos open the full-screen viewer, and Add uploads another', async ({ page, baseURL }) => {
  const origin = baseURL as string;
  const row = await createRequest(page, origin);
  const upload = await page.request.post(`/api/requests/${row.id}/photos`, {
    headers: { Origin: origin },
    multipart: {
      photoId: randomUUID(),
      timing: 'today',
      photo: { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: JPEG },
      thumb: { name: 'thumb.jpg', mimeType: 'image/jpeg', buffer: JPEG },
    },
  });
  expect(upload.ok(), `photo upload → ${upload.status()}`).toBe(true);

  await page.goto(`/?r=${row.id}`);
  await page.getByRole('button', { name: 'Photo 1 of 1, Today' }).click();
  const viewer = page.getByTestId('photo-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('heading', { name: '1 of 1' })).toBeVisible();
  await expect(viewer.getByTestId('photo-timing')).toHaveText('Today');
  await expect(viewer).toContainText(FRONT.staffName);
  await page.getByRole('button', { name: 'Close photo' }).click();
  await expect(viewer).toBeHidden();
  await expect(auditItems(page).first()).toContainText('Photo added');

  // Add from the profile: pick, skip the crop with Escape (the whole photo), choose Not today, upload.
  await page.getByLabel('Add photo').setInputFiles({ name: 'second.jpg', mimeType: 'image/jpeg', buffer: JPEG });
  const crop = page.getByRole('dialog', { name: 'Crop photo' });
  await expect(crop.getByRole('button', { name: 'Use photo' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(crop).toBeHidden();
  const sheet = page.getByRole('dialog', { name: 'Add photo' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('radio', { name: 'Not today' }).click();
  await sheet.getByRole('button', { name: 'Add photo' }).click();
  await expect(sheet).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Photo 2 of 2, Not today' })).toBeVisible({ timeout: 15_000 });
});

// F2 review (a): Retake on a later photo of a multi-photo pick must not lose the photos already kept. Before
// the fix the kept one was prepared and shown at once, the input went disabled, and the retaken photo then
// replaced it in the Add sheet.
test('Add with two photos: Use on the first, Retake on the second, a new photo: both are in the Add sheet and upload', async ({ page, baseURL }) => {
  const origin = baseURL as string;
  const row = await createRequest(page, origin);
  await page.goto(`/?r=${row.id}`);
  await expect(page.getByTestId('add-photo')).toBeVisible({ timeout: 15_000 });

  await page.getByLabel('Add photo').setInputFiles([
    { name: 'one.jpg', mimeType: 'image/jpeg', buffer: JPEG },
    { name: 'two.jpg', mimeType: 'image/jpeg', buffer: JPEG },
  ]);
  const crop = page.getByRole('dialog', { name: 'Crop photo' });
  await expect(crop.getByText('1 of 2', { exact: true })).toBeVisible();
  await crop.getByRole('button', { name: 'Use photo' }).click();
  await expect(crop.getByText('2 of 2', { exact: true })).toBeVisible();
  // Past the next photo's guard (a tap this soon is ignored, CropSheet FRESH_MS).
  await page.waitForTimeout(500);
  // Nothing is prepared or shown while the retake is open: no Add sheet yet.
  const chooser = page.waitForEvent('filechooser');
  await crop.getByRole('button', { name: 'Retake' }).click();
  const picker = await chooser;
  await expect(crop).toBeHidden();
  await expect(page.getByRole('dialog', { name: /^Add/ })).toHaveCount(0);
  await expect(page.getByLabel('Add photo')).toBeEnabled();
  await picker.setFiles({ name: 'three.jpg', mimeType: 'image/jpeg', buffer: JPEG });
  // The new photo joins the run: the second of two.
  await expect(crop.getByText('2 of 2', { exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  await crop.getByRole('button', { name: 'Use photo' }).click();
  await expect(crop).toBeHidden();

  const sheet = page.getByRole('dialog', { name: 'Add 2 photos' });
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByRole('img')).toHaveCount(2);
  await expect(sheet.getByRole('img', { name: 'New photo 1' })).toBeVisible();
  await expect(sheet.getByRole('img', { name: 'New photo 2' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Add 2 photos' }).click();
  await expect(sheet).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Photo 2 of 2, Today' })).toBeVisible({ timeout: 15_000 });
});

test('Retake on a later photo, then the picker closed with no photo: the kept photo still reaches the Add sheet', async ({ page, baseURL }) => {
  const origin = baseURL as string;
  const row = await createRequest(page, origin);
  await page.goto(`/?r=${row.id}`);
  await expect(page.getByTestId('add-photo')).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('Add photo').setInputFiles([
    { name: 'one.jpg', mimeType: 'image/jpeg', buffer: JPEG },
    { name: 'two.jpg', mimeType: 'image/jpeg', buffer: JPEG },
  ]);
  const crop = page.getByRole('dialog', { name: 'Crop photo' });
  await crop.getByRole('button', { name: 'Use photo' }).click();
  await expect(crop.getByText('2 of 2', { exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  const chooser = page.waitForEvent('filechooser');
  await crop.getByRole('button', { name: 'Retake' }).click();
  await chooser;
  await expect(crop).toBeHidden();
  // The picker is dismissed: the browser fires `cancel` on the input.
  await page.getByLabel('Add photo').dispatchEvent('cancel');
  const sheet = page.getByRole('dialog', { name: 'Add photo' });
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByRole('img')).toHaveCount(1);
});

test("another person's answer shows the conflict banner and the new status within a poll", async ({ browser, page, baseURL }) => {
  const origin = baseURL as string;
  const row = await createRequest(page, origin);
  await page.goto(`/?r=${row.id}`);
  await expect(statusBlock(page)).toContainText('Waiting for check');

  const liaison = await otherPerson(browser, LIAISON, origin);
  await setStatus(liaison.page, origin, row, 'Found – Awaiting Reunion', 'answer');
  await liaison.context.close();

  await expect(page.getByText('Updated by someone else')).toBeVisible({ timeout: 15_000 });
  await expect(profileStatus(page, 'Found – Awaiting Reunion')).toBeVisible();
  await expect(statusBlock(page)).toContainText(LIAISON.staffName);
  await expect(auditItems(page).first()).toContainText(`${LIAISON.staffName} · Medical`);
});

test('offline disables the answer buttons with "Needs a connection"', async ({ context, page, baseURL }) => {
  const origin = baseURL as string;
  const row = await createRequest(page, origin);
  await page.goto(`/?r=${row.id}`);
  const answer = page.getByRole('button', { name: 'In medical', exact: true });
  await expect(answer).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByTestId('profile-actions')).toContainText('Needs a connection');
  await expect(answer).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Not in medical', exact: true })).toBeDisabled();
  await context.setOffline(false);
  await expect(answer).toBeEnabled({ timeout: 15_000 });
});

test('offline disables Change answer too', async ({ context, page, baseURL }) => {
  const origin = baseURL as string;
  const row = await createRequest(page, origin);
  await setStatus(page, origin, row, 'Found – Awaiting Reunion', 'answer');
  await page.goto(`/?r=${row.id}`);
  await expect(changeAnswer(page)).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByTestId('profile-actions')).toContainText('Needs a connection');
  await expect(changeAnswer(page)).toBeDisabled();
  await context.setOffline(false);
  await expect(changeAnswer(page)).toBeEnabled({ timeout: 15_000 });
});

test('closing a deep-linked profile shows the list', async ({ page, baseURL }) => {
  const origin = baseURL as string;
  const row = await createRequest(page, origin);
  await page.goto(`/?r=${row.id}`);
  await expect(page.getByTestId('profile')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('profile')).toHaveCount(0);
});
