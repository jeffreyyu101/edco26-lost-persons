// Signed-in e2e sessions (v2.1 A17: "signs in once per file with storageState"). Every session comes from
// the real sign-in route, POST /api/session with the .env.test event password, never from a cookie minted
// in the test. Each identity signs in once per worker (one file at a time, workers: 1); its storage state
// is then reused by every test and every extra context of that identity.
//
//   signedInAs(STAFF)                          at file or describe level: the default context is signed in
//   await newSignedInContext(browser, STAFF)   a second phone (another identity) in the same test
//   await sessionCookieHeader(STAFF)           a Cookie header for plain HTTP checks
//
// Synthetic identities only.
import { randomInt } from 'node:crypto';
import './api-event';
import { request, test, type Browser, type BrowserContext, type BrowserContextOptions } from '@playwright/test';
import { TEST_EVENT_ID, loadTestEnv, testBaseUrl } from '../../../scripts/test-env.mjs';

export interface TestStaff {
  staffName: string;
  /** A canonical team value (lib/domain TEAM_VALUES). */
  team: string;
  /** (Events) Sign in with the lead passcode (LP_LEAD_PASSCODE) and open the local test event. */
  lead?: boolean;
}

export type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>;

const states = new Map<string, Promise<StorageState>>();

/** A fake client IP per sign-in (100.64.0.0/10), so no other test's failed attempts can rate-limit it. */
function fakeIp(): string {
  return `100.${64 + randomInt(64)}.${randomInt(256)}.${1 + randomInt(254)}`;
}

async function signIn(staff: TestStaff): Promise<StorageState> {
  const env: Record<string, string | undefined> = loadTestEnv();
  const password = staff.lead ? env['LP_LEAD_PASSCODE'] : env['APP_SHARED_PASSWORD'];
  if (!password) throw new Error(`.env.test has no ${staff.lead ? 'LP_LEAD_PASSCODE' : 'APP_SHARED_PASSWORD'}`);
  const base = testBaseUrl();
  const ip = fakeIp();
  const ctx = await request.newContext({ baseURL: base });
  try {
    const res = await ctx.post('/api/session', {
      headers: { origin: base, 'x-vercel-forwarded-for': ip, 'x-real-ip': ip },
      data: { staffName: staff.staffName, team: staff.team, password },
    });
    if (res.status() !== 200) throw new Error(`POST /api/session for a test identity → ${res.status()}`);
    if (staff.lead) {
      // A lead opens the local event (a re-issued cookie with it), as the Events list does.
      const opened = await ctx.post('/api/session/event', { headers: { origin: base }, data: { eventId: TEST_EVENT_ID } });
      if (opened.status() !== 200) throw new Error(`POST /api/session/event for a test lead → ${opened.status()}`);
    }
    const state = await ctx.storageState();
    if (!state.cookies.some((c) => c.name === 'lp_session')) throw new Error('POST /api/session set no lp_session cookie');
    return state;
  } finally {
    await ctx.dispose();
  }
}

/** The storage state of a signed-in `staff` (signed in through POST /api/session on first use). */
export function signedInState(staff: TestStaff): Promise<StorageState> {
  const key = `${staff.staffName}\u0000${staff.team}\u0000${staff.lead ? 'lead' : 'staff'}`;
  let state = states.get(key);
  if (!state) {
    state = signIn(staff);
    states.set(key, state);
    state.catch(() => states.delete(key));
  }
  return state;
}

/** Every test in the file (or describe) starts with `staff` signed in. */
export function signedInAs(staff: TestStaff): void {
  test.use({
    // Playwright reads a fixture's dependencies from its first parameter, so it must be a destructuring.
    storageState: async ({}, provide) => {
      await provide(await signedInState(staff));
    },
  });
}

/** A second phone signed in as `staff`. The caller closes it. */
export async function newSignedInContext(browser: Browser, staff: TestStaff, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  return browser.newContext({ ...options, storageState: await signedInState(staff) });
}

/** "lp_session=…" for `staff`, for checks that fetch pages without a browser context. */
export async function sessionCookieHeader(staff: TestStaff): Promise<string> {
  const cookie = (await signedInState(staff)).cookies.find((c) => c.name === 'lp_session');
  if (!cookie) throw new Error('no lp_session cookie');
  return `${cookie.name}=${cookie.value}`;
}

/**
 * (Events) Forgets every cached sign-in of this worker. A test that changes the lead passcode signs every lead session
 * out (their cookies carry the old passcode version); files after it then sign in again.
 */
export function forgetSignedInStates(): void {
  states.clear();
}
