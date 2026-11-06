import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { CreateResponse, ChangeResponse, RequestDetail, RequestSummary } from '../../lib/api-types';
import { newSignedInContext, signedInAs } from './helpers/session';

// Profile (spec §8 Profile, §9.4): answer, change answer, Reunited, Discharged and Reopen from the
// profile; cancel (creator only, with the confirm) and reopen; edits in the audit trail with old → new;
// photos and the full-screen viewer; another person's change while it is open; offline disables actions.
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
  await expect(statusBlock(page)).toContainText('Maya R. heading to Main Med');
  await expect(auditItems(page).first()).toContainText('Waiting for check');
  await expect(auditItems(page).first()).toContainText('In medical');
  await expect(auditItems(page).first()).toContainText(`${FRONT.staffName} · Dispatch`);

  // Change answer → Not in medical → Change answer → In medical.
  await page.getByRole('button', { name: 'Change answer to Not in medical' }).click();
  await expect(profileStatus(page, 'Checked – Not Found')).toBeVisible();
  await expect(statusBlock(page)).toContainText(FRONT.staffName);
  await page.getByRole('button', { name: 'Change answer to In medical' }).click();
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

  // Add from the profile: pick, choose Not today, upload.
  await page.getByLabel('Add photo').setInputFiles({ name: 'second.jpg', mimeType: 'image/jpeg', buffer: JPEG });
  const sheet = page.getByRole('dialog', { name: 'Add photo' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('radio', { name: 'Not today' }).click();
  await sheet.getByRole('button', { name: 'Add photo' }).click();
  await expect(sheet).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Photo 2 of 2, Not today' })).toBeVisible({ timeout: 15_000 });
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

test('closing a deep-linked profile shows the list', async ({ page, baseURL }) => {
  const origin = baseURL as string;
  const row = await createRequest(page, origin);
  await page.goto(`/?r=${row.id}`);
  await expect(page.getByTestId('profile')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('profile')).toHaveCount(0);
});
