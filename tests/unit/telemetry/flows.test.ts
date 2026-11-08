// Timed flows (lib/client/telemetry/flows.ts, design §1.4): store snapshot sequences give flow_open, flow_resume,
// flow_new, flow_submit, flow_answer, flow_msg / flow_read, flow_alert and flow_push. Only durations, counts and enums
// come out: never a request id, message id or row value.
import { beforeEach, describe, expect, it } from 'vitest';
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { STATUS } from '@/lib/domain';
import { createServerState, type StoreState } from '@/lib/client/store-contract';
import type { MessageJob } from '@/lib/client/messages-logic';
import type { TelEvent } from '@/lib/client/telemetry/buffer';
import { Flows } from '@/lib/client/telemetry/flows';

const ID = '0f0f0f0f-0000-4000-8000-000000000044';
const ID2 = '0f0f0f0f-0000-4000-8000-000000000045';
const T0 = Date.UTC(2026, 10, 9, 3, 0, 0);

let now = T0;
let visible = true;
let events: TelEvent[];
let slows: Array<{ what: string; a: string; ms: number }>;
let flows: Flows;

const base = (): StoreState => ({
  ...createServerState('America/New_York'),
  hydrated: true,
  hasData: true,
  session: { status: 'active', staffName: 'TEST-u Quorra Zyxwvut', team: 'Medical', staff: 'TEST-u Quorra Zyxwvut · Medical', expiresAt: null },
});

const row = (id: string, over: Partial<RequestSummary> = {}) =>
  ({ id, rowVersion: 1, status: STATUS.waiting, createdAt: new Date(now - 60_000).toISOString(), firstName: 'Quorra', lastName: 'Zyxwvut', ...over }) as RequestSummary;

const job = (id: string, over: Partial<OutboxItem> = {}) =>
  ({ mutationId: id, payload: {}, photos: [], serverId: null, caseNumber: null, state: 'pending', attempts: 0, nextAttemptAt: null, lastError: null, operator: { staffName: 'x', team: 'y', staff: 'x · y' }, createdAt: now, source: 'app', ...over }) as unknown as OutboxItem;

beforeEach(() => {
  now = T0;
  visible = true;
  events = [];
  slows = [];
  flows = new Flows({
    now: () => now,
    timeOrigin: T0 - 2_000,
    visible: () => visible,
    desk: () => false,
    emit: (e) => events.push(e),
    slow: (what, a, ms) => slows.push({ what, a, ms }),
  });
});

const of = (n: string) => events.filter((e) => e.n === n);

describe('flow_open', () => {
  it('collector loaded before the first sync: launch to fresh data, with the cache flag', () => {
    const s0 = { ...base(), hasData: true };
    flows.onState(s0, null, []);
    now += 1_500;
    flows.onState({ ...s0, lastSyncLocalAt: now, lastSyncAt: new Date(now).toISOString() }, s0, []);
    expect(of('flow_open')).toEqual([expect.objectContaining({ ms: 3_500, p: expect.objectContaining({ out: 'ok', cache: 'yes' }) })]);
  });

  it('collector loaded after the first sync: read at once (cache unknown)', () => {
    const s = { ...base(), lastSyncLocalAt: T0 - 500, lastSyncAt: new Date(T0 - 500).toISOString() };
    flows.onState(s, null, []);
    expect(of('flow_open')).toEqual([expect.objectContaining({ ms: 1_500, p: expect.objectContaining({ out: 'ok', cache: 'unk' }) })]);
  });

  it('no fresh data 30 s after launch: out offline (or none), once; slow over 8 s', () => {
    flows.onState(base(), null, []);
    now = T0 + 29_000;
    flows.tick(now, true);
    expect(of('flow_open')).toEqual([expect.objectContaining({ p: expect.objectContaining({ out: 'offline' }) })]);
    flows.tick(now + 5_000, true);
    expect(of('flow_open')).toHaveLength(1);
    const slow = new Flows({ now: () => now, timeOrigin: T0 - 9_000, visible: () => true, desk: () => false, emit: () => undefined, slow: (what, a, ms) => slows.push({ what, a, ms }) });
    slow.onState({ ...base(), lastSyncLocalAt: now }, null, []);
    expect(slows).toEqual([expect.objectContaining({ what: 'open', a: 'flow_open' })]);
  });
});

describe('flow_resume', () => {
  it('visible again → the next fresh sync after it; away in seconds', () => {
    const s = { ...base(), lastSyncLocalAt: T0 };
    flows.onState(s, null, []);
    flows.onVisibility(false, now);
    now += 600_000;
    flows.onVisibility(true, now);
    now += 900;
    flows.onState({ ...s, lastSyncLocalAt: now }, s, []);
    expect(of('flow_resume')).toEqual([expect.objectContaining({ ms: 900, p: { out: 'ok', away: 600 } })]);
  });

  it('the connection failing first: out fail; nothing in 30 s: out none', () => {
    const s = { ...base(), lastSyncLocalAt: T0 };
    flows.onState(s, null, []);
    flows.onVisibility(true, now);
    flows.onState({ ...s, connection: 'offline' }, s, []);
    expect(of('flow_resume').at(-1)?.p?.out).toBe('fail');
    flows.onVisibility(false, now);
    flows.onVisibility(true, now);
    flows.tick(now + 31_000, false);
    expect(of('flow_resume').at(-1)?.p?.out).toBe('none');
  });
});

describe('flow_new and flow_submit', () => {
  it('a submit: section dwell, fields, the outbox job within 3 s; then submit → server', () => {
    const s0 = base();
    flows.onState(s0, null, []);
    flows.onView('new', 'pending', now);
    now += 1_000;
    flows.onField('person', 'name', now);
    now += 4_000;
    flows.onField('person', 'lastseen', now);
    now += 2_000;
    flows.onField('friend', 'contactphone', now);
    now += 3_000;
    flows.onTap('request-form-submit', null, now);
    now += 200;
    const s1 = { ...s0, outbox: [job('m1')] };
    flows.onState(s1, s0, []);
    const fn = of('flow_new')[0];
    expect(fn).toEqual(expect.objectContaining({ ms: 10_200, p: expect.objectContaining({ out: 'submit', from: 'pending', s_person: 6_000, s_friend: 3_200, fields: 3, inval: 0, desk: false }) }));
    now += 800;
    const s2 = { ...s1, outbox: [job('m1', { serverId: ID, attempts: 1 })] };
    flows.onState(s2, s1, []);
    now += 400;
    flows.onState({ ...s2, outbox: [] }, s2, []);
    expect(of('flow_submit')).toEqual([expect.objectContaining({ ms: 1_200, p: { out: 'ok', tries: 1, offline: false, photos: 0 } })]);
  });

  it('an invalid submit then leaving: abandon with inval 1; a job that needs attention', () => {
    const s0 = base();
    flows.onState(s0, null, []);
    flows.onView('new', 'all', now);
    flows.onTap('request-form-submit', null, now);
    flows.onInvalid();
    now += 5_000;
    flows.onView('all', 'new', now);
    expect(of('flow_new')).toEqual([expect.objectContaining({ p: expect.objectContaining({ out: 'abandon', inval: 1 }) })]);
    const s1 = { ...s0, outbox: [job('m2')] };
    flows.onState(s1, s0, []);
    flows.onState({ ...s1, connection: 'offline', outbox: [job('m2', { state: 'needs_attention' })] }, s1, []);
    expect(of('flow_submit')).toEqual([expect.objectContaining({ p: expect.objectContaining({ out: 'attention', offline: true }) })]);
  });

  it('a job already queued before the collector started is not timed', () => {
    const s1 = { ...base(), outbox: [job('old')] };
    flows.onState(s1, null, []);
    flows.onState({ ...s1, outbox: [] }, s1, []);
    expect(of('flow_submit')).toEqual([]);
  });
});

describe('flow_answer', () => {
  const answered = (s: StoreState, version: number): StoreState => ({ ...s, pending: new Map(), confirmed: new Map([[ID, row(ID, { rowVersion: version })]]) });

  it('from Overlay.startedAt to its removal: ok when rowVersion moved; queued and st from the request', () => {
    const s0 = { ...base(), confirmed: new Map([[ID, row(ID)]]) };
    flows.onState(s0, null, []);
    const s1 = { ...s0, pending: new Map([[ID, { mutationId: 'mu1', kind: 'status' as const, fields: { status: STATUS.inMedical }, startedAt: now }]]) };
    flows.onState(s1, s0, []);
    flows.onNetStart({ id: 1, pattern: '/api/requests/:id/status', path: `/api/requests/${ID}/status`, method: 'post', t: now + 40 });
    flows.onNetEnd({ id: 1, pattern: '/api/requests/:id/status', path: `/api/requests/${ID}/status`, method: 'post', t: now + 40, st: '2xx', end: now + 400 });
    now += 450;
    flows.onState(answered(s1, 2), s1, []);
    expect(of('flow_answer')).toEqual([expect.objectContaining({ ms: 450, p: { kind: 'status', out: 'ok', to: 'in_medical', queued: 40, st: '2xx' } })]);
    expect(JSON.stringify(events)).not.toContain(ID);
  });

  it('failed on a red toast, conflict on amber, offline when the connection is offline', () => {
    for (const [tones, conn, out] of [
      [['red'], 'live', 'failed'],
      [['amber'], 'live', 'conflict'],
      [[], 'offline', 'offline'],
    ] as const) {
      events = [];
      const s0 = { ...base(), confirmed: new Map([[ID, row(ID)]]) };
      flows.onState(s0, null, []);
      const s1 = { ...s0, pending: new Map([[ID, { mutationId: `m-${out}`, kind: 'status' as const, fields: { status: STATUS.notInMedical }, startedAt: now }]]) };
      flows.onState(s1, s0, []);
      flows.onState({ ...answered(s1, 1), connection: conn }, s1, [...tones]);
      expect(of('flow_answer')[0]?.p?.out, out).toBe(out);
    }
  });
});

describe('flow_msg and flow_read', () => {
  const msgJob = (id: string, state: MessageJob['state'] = 'pending'): MessageJob => ({ id, kind: 'message', requestId: ID, body: 'TEST secret plum', operator: 'x', createdAt: now, state, attempts: 1, nextAttemptAt: null, error: null });

  it('a message job → gone after a 2xx: ok; then read when the receipt shows it (server times)', () => {
    flows.onMessages({ threads: new Map(), jobs: [] });
    flows.onMessages({ threads: new Map(), jobs: [msgJob('j1')] });
    flows.onNetEnd({ id: 1, pattern: '/api/requests/:id/messages', path: `/api/requests/${ID}/messages`, method: 'post', t: now, st: '2xx', end: now + 300 });
    now += 500;
    flows.onMessages({ threads: new Map(), jobs: [] });
    expect(of('flow_msg')).toEqual([expect.objectContaining({ ms: 500, p: { q: 'message', out: 'ok', tries: 1, offline: false } })]);
    const created = new Date(now - 400).toISOString();
    const message = { id: 'srv-1', staff: 'x', by: 'x', team: 'y', body: 'TEST secret plum', createdAt: created, mine: true, clientMutationId: 'j1' };
    flows.onMessages({ threads: new Map([[ID, { status: 'ready', messages: [message], hasEarlier: false, loadingEarlier: false, receipt: { messageId: 'srv-1', readAt: null }, loadedAt: now }]]), jobs: [] });
    expect(of('flow_read')).toEqual([]);
    now += 60_000;
    const readAt = new Date(Date.parse(created) + 30_000).toISOString();
    flows.onMessages({ threads: new Map([[ID, { status: 'ready', messages: [message], hasEarlier: false, loadingEarlier: false, receipt: { messageId: 'srv-1', readAt }, loadedAt: now }]]), jobs: [] });
    expect(of('flow_read')).toEqual([expect.objectContaining({ ms: 30_000 })]);
    expect(JSON.stringify(events)).not.toMatch(/plum|srv-1|j1/);
  });

  it('a job that went to failed: out failed, once; one removed without a 2xx: discarded', () => {
    flows.onMessages({ threads: new Map(), jobs: [] });
    flows.onMessages({ threads: new Map(), jobs: [msgJob('j2')] });
    flows.onMessages({ threads: new Map(), jobs: [msgJob('j2', 'failed')] });
    flows.onMessages({ threads: new Map(), jobs: [msgJob('j2', 'failed')] });
    flows.onMessages({ threads: new Map(), jobs: [msgJob('j3')] });
    flows.onMessages({ threads: new Map(), jobs: [] });
    expect(of('flow_msg').map((e) => e.p?.out)).toEqual(['failed', 'discarded']);
  });
});

describe('flow_alert and flow_push', () => {
  const synced = (confirmed: Map<string, RequestSummary>, over: Partial<StoreState> = {}): StoreState => ({ ...base(), lastSyncLocalAt: now, lastSyncAt: new Date(now).toISOString(), confirmed, ...over });

  it('a new request from someone else → the in-app toast within 2 s: route toast, ms in server time', () => {
    const s0 = synced(new Map());
    flows.onState(s0, null, []);
    now += 6_000;
    const s1 = synced(new Map([[ID, row(ID, { createdAt: new Date(now - 4_000).toISOString() })]]));
    flows.onState(s1, s0, []);
    now += 300;
    flows.onAlert({ kind: 'new_request' }, now);
    expect(of('flow_alert')).toEqual([expect.objectContaining({ ms: 4_300, p: expect.objectContaining({ route: 'toast', seen: 4_000, vis: true, skew: 'ok' }) })]);
  });

  it('no toast within 2 s: none (or off when New requests is off); my own requests never count', () => {
    const s0 = synced(new Map());
    flows.onState(s0, null, []);
    const s1 = synced(new Map([[ID, row(ID)], [ID2, row(ID2)]]), { myIds: new Set([ID2]), prefs: { ...base().prefs, bell: false } });
    flows.onState(s1, s0, []);
    flows.tick(now + 2_500, false);
    expect(of('flow_alert')).toEqual([expect.objectContaining({ p: expect.objectContaining({ route: 'off' }) })]);
  });

  it('hidden: a push of kind new_request from the worker’s log resolves it (route push); else hidden', () => {
    const s0 = synced(new Map());
    flows.onState(s0, null, []);
    visible = false;
    const s1 = synced(new Map([[ID, row(ID, { createdAt: new Date(now - 2_000).toISOString() })]]));
    flows.onState(s1, s0, []);
    const rx = now + 1_000;
    flows.onSwEntries([{ e: 'rx', k: 'new_request', at: rx, sent: now - 1_500, fr: false, sh: true, si: false }]);
    expect(of('flow_alert')).toEqual([expect.objectContaining({ ms: 3_000, p: expect.objectContaining({ route: 'push', vis: false }) })]);
    expect(of('push_rx')).toEqual([expect.objectContaining({ ms: 2_500, p: { kind: 'new_request', front: false, shown: true, silent: false } })]);
  });

  it('a notification click then the request on screen within 15 s: flow_push ok; else not_shown', () => {
    flows.onSwEntries([{ e: 'click', k: 'in_medical', ps: true, at: now, age: 5_000, via: 'lp-open' }]);
    expect(of('notif_click')).toEqual([expect.objectContaining({ ms: 5_000, p: { src: 'push', via: 'lp-open', kind: 'in_medical' } })]);
    now += 800;
    flows.onView('profile', 'all', now);
    expect(of('flow_push')).toEqual([expect.objectContaining({ ms: 800, p: expect.objectContaining({ out: 'ok', via: 'lp-open', cold: false }) })]);
    flows.onSwEntries([{ e: 'click', k: null, ps: false, at: now, age: null, via: 'nav' }]);
    flows.tick(now + 16_000, false);
    expect(of('flow_push').at(-1)?.p).toEqual(expect.objectContaining({ out: 'not_shown', src: 'page' }));
  });
});
