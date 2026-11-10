// (Events, phase 2) Test events made through the real lead routes, on the local stack only: a lead session (the lead
// passcode of .env.test), POST /api/events, its staff password, go live, end. Every event a spec makes is ended in its
// afterAll (endAll), so no other spec's sign-in cards or running events see it. Synthetic names only.
import { randomInt, randomUUID } from 'node:crypto';
import { expect, request, type APIRequestContext, type BrowserContext } from '@playwright/test';
import type { EventAdmin, EventPost, EventTeam } from '@/lib/api-types';
import { loadTestEnv, testBaseUrl } from '../../../scripts/test-env.mjs';

export const BASE = testBaseUrl();

/** A fake client IP per sign-in (100.64.0.0/10), so no other test's failed attempts can rate-limit it. */
export function fakeIp(): string {
  return `100.${64 + randomInt(64)}.${randomInt(256)}.${1 + randomInt(254)}`;
}

let leadCtx: Promise<APIRequestContext> | null = null;

/** A lead session (the lead passcode), shared by the file. */
export function lead(): Promise<APIRequestContext> {
  leadCtx ??= (async () => {
    const env: Record<string, string | undefined> = loadTestEnv();
    const passcode = env['LP_LEAD_PASSCODE'];
    if (!passcode) throw new Error('.env.test has no LP_LEAD_PASSCODE');
    const ctx = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } });
    const ip = fakeIp();
    const res = await ctx.post('/api/session', { headers: { 'x-real-ip': ip }, data: { staffName: 'TEST-EV Lead', team: 'Other', otherTeam: 'Ground Control', password: passcode } });
    expect(res.status(), await res.text()).toBe(200);
    return ctx;
  })();
  return leadCtx;
}

export interface TestEvent {
  id: string;
  slug: string;
  name: string;
  password: string;
  config: EventAdmin;
}

const made: string[] = [];

export interface EventSpec {
  name: string;
  posts: Array<Omit<EventPost, 'id'> & { id?: string }>;
  teams: Array<Omit<EventTeam, 'id' | 'medical'> & { id?: string; medical?: boolean }>;
  timezone?: string;
  dayStartHour?: number;
  lastSeen?: string[];
  mainMedical?: string;
  /** Leave it in practice (default: live). */
  practice?: boolean;
  /** Show days around today (default: yesterday to tomorrow). */
  startsOn?: string;
  endsOn?: string;
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** A new event through the lead routes, with a staff password; live unless `practice`. */
export async function makeEvent(spec: EventSpec): Promise<TestEvent> {
  const ctx = await lead();
  const slug = `ev-${randomUUID().slice(0, 8)}`;
  const created = await ctx.post('/api/events', {
    data: {
      slug,
      name: spec.name,
      startsOn: spec.startsOn ?? day(-1),
      endsOn: spec.endsOn ?? day(1),
      timezone: spec.timezone ?? 'America/New_York',
      dayStartHour: spec.dayStartHour ?? 6,
      posts: spec.posts,
      teams: spec.teams,
      lastSeen: spec.lastSeen ?? [],
      ...(spec.mainMedical ? { mainMedical: spec.mainMedical } : {}),
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const event = ((await created.json()) as { event: EventAdmin }).event;
  made.push(event.id);
  const password = `pw-${randomUUID()}`;
  const pw = await ctx.post(`/api/events/${event.id}/password`, { data: { password } });
  expect(pw.status(), await pw.text()).toBe(200);
  let config = ((await pw.json()) as { event: EventAdmin }).event;
  if (!spec.practice) config = await goLive(event.id);
  return { id: event.id, slug, name: spec.name, password, config };
}

export async function goLive(id: string): Promise<EventAdmin> {
  const res = await (await lead()).post(`/api/events/${id}/go-live`, { data: {} });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { event: EventAdmin }).event;
}

/** A fresh join link of the event (POST /api/events/:id/join-link): the token after `#join=` ("<slug>.<code>"). */
export async function joinToken(id: string): Promise<string> {
  const res = await (await lead()).post(`/api/events/${id}/join-link`, { data: {} });
  expect(res.status(), await res.text()).toBe(201);
  const { link } = (await res.json()) as { link: string };
  return decodeURIComponent(new URL(link).hash.slice('#join='.length));
}

/** Ends the event (an event still in practice goes live first: only a live event can end). */
export async function endEvent(id: string): Promise<void> {
  const ctx = await lead();
  let res = await ctx.post(`/api/events/${id}/end`, { data: {} });
  if (res.status() === 409) {
    // 409 "Not possible at this stage": still in practice (go live, then end), or already archived (go-live 409s too).
    await ctx.post(`/api/events/${id}/go-live`, { data: {} });
    res = await ctx.post(`/api/events/${id}/end`, { data: {} });
  }
  expect([200, 409], await res.text()).toContain(res.status());
  const after = await ctx.get(`/api/events/${id}`);
  if (after.ok()) expect(((await after.json()) as { event: EventAdmin }).event.stage, `event ${id} still running`).toBe('archived');
}

/** Ends every event this file made (afterAll). */
export async function endAll(): Promise<void> {
  for (const id of made.splice(0)) await endEvent(id).catch(() => undefined);
  if (leadCtx) await (await leadCtx).dispose();
  leadCtx = null;
}

/** Signs `context` in (POST /api/session, the cookie lands in the context) as staff of the event with `password`. */
export async function signInContext(context: BrowserContext, password: string, staffName: string, team: string): Promise<void> {
  const res = await context.request.post(`${BASE}/api/session`, {
    headers: { origin: BASE, 'x-real-ip': fakeIp() },
    data: { staffName, team: 'Other', otherTeam: team, password },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** A session cookie for staff of the event with `password`, signed in from a context of its own. */
export async function staffCookie(password: string, staffName: string, team: string): Promise<{ value: string; api: APIRequestContext }> {
  const api = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } });
  const res = await api.post('/api/session', { headers: { 'x-real-ip': fakeIp() }, data: { staffName, team: 'Other', otherTeam: team, password } });
  expect(res.status(), await res.text()).toBe(200);
  const cookie = (await api.storageState()).cookies.find((c) => c.name === 'lp_session');
  if (!cookie) throw new Error('no lp_session');
  return { value: cookie.value, api };
}

/** A request created through the API with the given session (context.request or a staff API context). */
export async function apiCreate(api: APIRequestContext, body: { name: string; reportingLocation: string; otherLocation?: string | null }): Promise<{ id: string; name: string; createdAt: string; caseNumber: number }> {
  const res = await api.post(`${BASE}/api/requests`, {
    headers: { origin: BASE },
    data: { clientMutationId: randomUUID(), clothing: 'Synthetic test tee', ...body },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { request: { id: string; name: string; createdAt: string; caseNumber: number } }).request;
}

/** Every row name the session sees (GET /api/sync, the first page is plenty for a fresh event). */
export async function rowNames(api: APIRequestContext): Promise<string[]> {
  const res = await api.get(`${BASE}/api/sync`);
  expect(res.ok(), `GET /api/sync → ${res.status()}`).toBe(true);
  return ((await res.json()) as { rows: Array<{ name: string }> }).rows.map((r) => r.name);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The brand row's dates for the signed-in event (GET /api/session), as the row shows them (CSS capitals): short
 * "NOV 9–11", long "NOVEMBER 9–11, 2026". The local test event's dates move with today (scripts/test-env.mjs).
 */
export async function eventDatesShown(api: APIRequestContext): Promise<{ short: string; long: string }> {
  const res = await api.get(`${BASE}/api/session`);
  expect(res.ok()).toBe(true);
  const { event } = (await res.json()) as { event: { startsOn: string; endsOn: string } };
  const [y1, m1, d1] = event.startsOn.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = event.endsOn.split('-').map(Number) as [number, number, number];
  const fmt = (form: 'short' | 'long') => {
    const month = (m: number) => (form === 'short' ? MONTHS[m - 1]!.slice(0, 3) : MONTHS[m - 1]!);
    const range = y1 === y2 && m1 === m2 ? (d1 === d2 ? `${month(m1)} ${d1}` : `${month(m1)} ${d1}–${d2}`) : `${month(m1)} ${d1}–${month(m2)} ${d2}`;
    return (form === 'long' ? `${range}, ${y2}` : range).toUpperCase();
  };
  return { short: fmt('short'), long: fmt('long') };
}
