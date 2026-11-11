// (Events) Event setup for a non-developer (cut-over drill, 2026-11-10):
//   * realistic post and team names with Short left empty are created, each short derived from its label
//     (lib/short-label.ts); a duplicate short (typed or derived) is refused with the item named (index, part);
//   * join-link creation with no expiry answers what is wrong with the event's dates;
//   * the sign-in cards carry their event's slug (a join link shows its own event's teams).
// Every event here is synthetic and ended at the end of the file.
import { afterAll, describe, expect, it } from 'vitest';
import type { EventAdmin } from '@/lib/api-types';
import { signInTeams } from '@/lib/server/events';
import { api, cookieFor, pii, psql, uniq, withTestServer } from './harness';

withTestServer();

const made: string[] = [];

async function leadCookie(): Promise<string> {
  return cookieFor({ staffName: pii(`TEST-S Lead ${uniq()}`), team: 'Site Ops' }, { role: 'lead', eventId: null });
}

const dayFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function create(body: Record<string, unknown>) {
  const res = await api<{ event: EventAdmin }>('/api/events', {
    json: { slug: `t-${uniq()}`.toLowerCase(), name: pii(`TEST-S Setup ${uniq()}`), startsOn: dayFromNow(0), endsOn: dayFromNow(1), ...body },
    cookie: await leadCookie(),
  });
  if (res.status === 201) made.push(res.body.event.id);
  return res;
}

afterAll(async () => {
  const lead = await leadCookie();
  for (const id of made) {
    await api(`/api/events/${id}/go-live`, { json: {}, cookie: lead });
    await api(`/api/events/${id}/end`, { json: {}, cookie: lead });
  }
  if (made.length) {
    psql(`update public.events set staff_password_hash = null, ended_password_hash = null, invite_code_sha256 = null, invite_expires_at = null
          where id = any (array[${made.map((id) => `'${id}'`).join(', ')}]::uuid[])`);
  }
});

const WARPED_POSTS = ['FA 1 – Main Stage', 'FA 2 – Vans Stage', 'Main Medical', 'Command', 'Roaming', 'Gate A'];

describe('Short left empty', () => {
  it('Warped Tour posts and a 28-character team, every Short empty: created, each short derived', async () => {
    const res = await create({ posts: WARPED_POSTS.map((label) => ({ label })), teams: [{ label: 'Ground Control Dispatch Team', short: '' }, { label: 'Medical', medical: true }] });
    expect(res.status, res.text).toBe(201);
    expect(res.body.event.posts.map((p) => [p.label, p.short])).toEqual([
      ['FA 1 – Main Stage', 'FA 1'],
      ['FA 2 – Vans Stage', 'FA 2'],
      ['Main Medical', 'Main Medical'],
      ['Command', 'Command'],
      ['Roaming', 'Roaming'],
      ['Gate A', 'Gate A'],
    ]);
    expect(res.body.event.teams.map((t) => t.short)).toEqual(['Ground Control Dispatch', 'Medical']);
    // The same through PATCH (the drill's "Merch Tent Info B", 17 characters).
    const patched = await api<{ event: EventAdmin }>(`/api/events/${res.body.event.id}`, { method: 'PATCH', json: { posts: [...res.body.event.posts, { label: 'Merch Tent Info B' }] }, cookie: await leadCookie() });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.body.event.posts.at(-1)).toMatchObject({ label: 'Merch Tent Info B', short: 'Merch Tent Info' });
  });

  it('a duplicate short is refused with the item named', async () => {
    const res = await create({ posts: [{ label: 'North Gate', short: 'North' }, { label: 'Main Stage' }, { label: 'North Tent', short: 'NORTH' }], teams: [{ label: 'Rovers' }] });
    expect(res.status).toBe(422);
    expect((res.body as unknown as { error: unknown }).error).toMatchObject({ code: 'invalid', message: 'Short already used', field: 'posts', index: 2, part: 'short' });
    const derived = await create({ teams: [{ label: 'Ground Control Dispatch Team' }, { label: 'Ground Control Dispatch Tent' }] });
    expect(derived.status).toBe(422);
    expect((derived.body as unknown as { error: unknown }).error).toMatchObject({ field: 'teams', index: 1, part: 'short' });
  });
});

describe('join link with no expiry: the dates are the problem', () => {
  it('an event whose last day has passed: "Event dates have passed"', async () => {
    const e = await create({ startsOn: '2025-06-01', endsOn: '2025-06-02' });
    expect(e.status, e.text).toBe(201);
    const res = await api(`/api/events/${e.body.event.id}/join-link`, { json: {}, cookie: await leadCookie() });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'invalid', message: 'Event dates have passed' });
  });
  it('an event more than 90 days away: "Event is more than 90 days away"', async () => {
    const e = await create({ startsOn: dayFromNow(120), endsOn: dayFromNow(121) });
    expect(e.status, e.text).toBe(201);
    const res = await api(`/api/events/${e.body.event.id}/join-link`, { json: {}, cookie: await leadCookie() });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'invalid', message: 'Event is more than 90 days away' });
  });
  it('an expiry the lead sends is still checked as before', async () => {
    const e = await create({});
    const res = await api(`/api/events/${e.body.event.id}/join-link`, { json: { expiresAt: new Date(Date.now() + 200 * 86_400_000).toISOString() }, cookie: await leadCookie() });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ message: 'Pick an expiry within 90 days', field: 'expiresAt' });
    expect((await api(`/api/events/${e.body.event.id}/join-link`, { json: {}, cookie: await leadCookie() })).status).toBe(201);
  });
});

describe('sign-in cards carry their event', () => {
  it('two running events with different teams: each card names its own event', async () => {
    const a = await create({ teams: [{ label: `Alpha ${uniq()}` }] });
    const b = await create({ teams: [{ label: `Bravo ${uniq()}` }, { label: 'Medical', medical: true }] });
    const cards = await signInTeams();
    const ofA = cards.filter((c) => c.event === a.body.event.slug).map((c) => c.label);
    const ofB = cards.filter((c) => c.event === b.body.event.slug).map((c) => c.label);
    expect(ofA).toEqual([a.body.event.teams[0]!.label]);
    expect(ofB).toEqual([b.body.event.teams[0]!.label, 'Medical']);
  });
});
