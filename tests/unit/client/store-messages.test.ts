// F3 through the real store (lib/client/store-core.ts + messages-core.ts) against the fake API: the durable
// message / en route outbox (saved before sending, offline "Sending…", sent exactly once, failures "Not
// delivered", 429, a reload, another staff's jobs), the thread, read cursors, the en route Undo, the message
// alert, and sign-out with queued messages. Synthetic data only.
import { STUB_EVENT } from '@/lib/client/stub-data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestSummary, ThreadMessage } from '@/lib/api-types';
import { K, openKv } from '@/lib/client/persist';
import type { MessagingApi } from '@/lib/client/messages-core';
import { STATUS, canonStaff } from '@/lib/domain';
import { createMessaging } from '@/lib/client/messages-core';
import { effectiveEnroute, failedEnrouteTap } from '@/lib/client/messages-logic';
import { advance, settle } from './helpers/env';
import { boot, finish, installStoreHooks, ready, values } from './helpers/boot';
import { FakeServer, STAFF, apiError, json, makeRow, type FakeRequest } from './helpers/fake-server';

installStoreHooks();

/** The messages endpoints, in memory: idempotent on clientMutationId, like lp_post_message. */
class Threads {
  messages: Array<ThreadMessage & { requestId: string }> = [];
  enroute = new Map<string, { etaMinutes: number | null; queuedMs: number | undefined; etaAt: string | null; state: string }>();
  reads: Array<{ requestId: string; upto: string | undefined }> = [];
  posts = 0;
  seq = 0;
  constructor(private server: FakeServer) {}

  activity(requestId: string) {
    const list = this.messages.filter((m) => m.requestId === requestId);
    const last = list[list.length - 1];
    const e = this.enroute.get(requestId);
    return {
      messageCount: list.length,
      lastMessageAt: last?.createdAt ?? null,
      unread: 0,
      needsInfo: false,
      lastMessage: last ? { by: last.by, mine: last.mine, text: last.body } : null,
      enroute: e && e.state !== 'none' ? { count: e.state === 'enroute' ? 1 : 0, earliestEta: e.etaAt, state: e.state, mine: { etaAt: e.etaAt, etaMinutes: e.etaMinutes, state: e.state } } : null,
      involved: true,
    };
  }

  handle = (req: FakeRequest): Response | undefined => {
    const m = /^\/api\/requests\/([^/]+)\/(messages|enroute)(\/read|\/[^/]+\/unsend)?$/.exec(req.path);
    if (!m) return undefined;
    const id = decodeURIComponent(m[1] ?? '');
    if (m[2] === 'messages' && !m[3] && req.method === 'GET') {
      const list = this.messages.filter((x) => x.requestId === id);
      return json(200, { messages: list, hasEarlier: false, receipt: null, activity: this.activity(id) });
    }
    if (m[2] === 'messages' && !m[3] && req.method === 'POST') {
      this.posts += 1;
      const body = req.body as { clientMutationId: string; body: string };
      const existing = this.messages.find((x) => x.clientMutationId === body.clientMutationId);
      if (existing) return json(200, { created: false, message: existing, activity: this.activity(id) });
      this.seq += 1;
      const message = {
        id: `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`,
        requestId: id,
        staff: this.server.session?.staff ?? '',
        by: 'Dana K.',
        team: 'Dispatch',
        body: body.body,
        createdAt: this.server.stamp(1000 + this.seq),
        mine: true,
        clientMutationId: body.clientMutationId,
      };
      this.messages.push(message);
      return json(201, { created: true, message, activity: this.activity(id) });
    }
    if (m[3] === '/read') {
      this.reads.push({ requestId: id, upto: (req.body as { upto?: string }).upto });
      return json(200, { changed: true, activity: { ...this.activity(id), unread: 0 } });
    }
    if (m[2] === 'enroute') {
      const b = req.body as { action: string; etaMinutes?: number | null; queuedMs?: number; etaAt?: string | null };
      if (b.action === 'cancel') this.enroute.set(id, { etaMinutes: null, queuedMs: undefined, etaAt: null, state: 'none' });
      else if (b.action === 'arrive') this.enroute.set(id, { ...(this.enroute.get(id) ?? { etaMinutes: null, queuedMs: undefined, etaAt: null }), state: 'arrived' });
      else this.enroute.set(id, { etaMinutes: b.etaMinutes ?? null, queuedMs: b.queuedMs, etaAt: b.etaAt ?? null, state: 'enroute' });
      return json(200, { changed: true, activity: this.activity(id) });
    }
    return undefined;
  };
}

function setup(rows: RequestSummary[] = [makeRow(1)], opts: Parameters<typeof boot>[1] = {}) {
  const server = new FakeServer(rows);
  const threads = new Threads(server);
  server.override = threads.handle;
  const booted = boot(server, opts);
  const api = booted.a.messages as MessagingApi;
  return { server, threads, api, ...booted };
}

const mjobKeys = async (dbName: string) => ((await openKv(dbName)?.keys()) ?? []).filter((k) => k.startsWith('mjob:'));
const ROW = makeRow(1).id;

describe('sending a message', () => {
  it('saves the job before sending, sends it once, then shows the confirmed message and its activity', async () => {
    const { api, threads, fe, s } = setup();
    await ready();
    const close = api.open(ROW);
    await settle();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const base = threads.handle;
    fe.server.override = async (req) => {
      if (req.method === 'POST' && req.path.endsWith('/messages')) await held;
      return base(req);
    };
    expect(await finish(api.send(ROW, '  Any tattoos or marks?  '))).toBe(true);
    await settle();
    expect(await mjobKeys(fe.dbName)).toHaveLength(1);
    expect(api.getSnapshot().jobs[0]).toMatchObject({ body: 'Any tattoos or marks?', state: 'sending' });
    release();
    await advance(50);
    expect(threads.posts).toBe(1);
    expect(api.getSnapshot().jobs).toHaveLength(0);
    expect(await mjobKeys(fe.dbName)).toHaveLength(0);
    expect(api.getSnapshot().threads.get(ROW)?.messages.map((m) => m.body)).toEqual(['Any tattoos or marks?']);
    expect(s().confirmed.get(ROW)).toMatchObject({ messageCount: 1, lastMessage: { text: 'Any tattoos or marks?', mine: true } });
    close();
  });

  it('refuses an empty or too long message (nothing queued)', async () => {
    const { api } = setup();
    await ready();
    expect(await finish(api.send(ROW, '   '))).toBe(false);
    expect(await finish(api.send(ROW, 'x'.repeat(501)))).toBe(false);
    expect(api.getSnapshot().jobs).toHaveLength(0);
  });

  it('offline it waits ("Sending…") and goes out exactly once when back online', async () => {
    const { api, threads, fe } = setup();
    await ready();
    fe.setOnline(false);
    await finish(api.send(ROW, 'On our way now'));
    await advance(30_000);
    expect(threads.posts).toBe(0);
    expect(api.getSnapshot().jobs[0]).toMatchObject({ state: 'pending', attempts: 0 });
    fe.setOnline(true);
    fe.fire('window', 'online');
    await advance(100);
    expect(threads.posts).toBe(1);
    expect(threads.messages).toHaveLength(1);
    expect(api.getSnapshot().jobs).toHaveLength(0);
  });

  it('a lost answer is retried with the same id: the server keeps one message', async () => {
    const { api, threads, fe } = setup();
    await ready();
    const base = threads.handle;
    let drop = true;
    fe.server.override = (req) => {
      const answer = base(req);
      if (drop && req.method === 'POST' && req.path.endsWith('/messages')) {
        drop = false;
        return 'network';
      }
      return answer;
    };
    await finish(api.send(ROW, 'Gate 3 side'));
    await advance(100);
    expect(threads.messages).toHaveLength(1);
    expect(api.getSnapshot().jobs[0]?.state).toBe('pending');
    await advance(5_000);
    expect(threads.posts).toBe(2);
    expect(threads.messages).toHaveLength(1);
    expect(api.getSnapshot().jobs).toHaveLength(0);
  });

  it('three failed tries online show "Not delivered"; Retry sends it', async () => {
    const { api, threads, fe } = setup();
    await ready();
    const base = threads.handle;
    let failing = true;
    fe.server.override = (req) => (failing && req.method === 'POST' && req.path.endsWith('/messages') ? apiError(503, 'unavailable', 'Down') : base(req));
    await finish(api.send(ROW, 'Hello'));
    await advance(100_000);
    expect(api.getSnapshot().jobs[0]).toMatchObject({ state: 'failed', error: { message: 'Not delivered' } });
    failing = false;
    api.retry(api.getSnapshot().jobs[0]?.id ?? '');
    await advance(100);
    expect(api.getSnapshot().jobs).toHaveLength(0);
    expect(threads.messages).toHaveLength(1);
  });

  it('a definitive rejection fails at once and is never retried by itself; Delete removes it', async () => {
    const { api, fe } = setup();
    await ready();
    fe.server.override = (req) => (req.method === 'POST' && req.path.endsWith('/messages') ? apiError(422, 'invalid', 'Too long') : undefined);
    await finish(api.send(ROW, 'Hello'));
    await advance(100);
    const job = api.getSnapshot().jobs[0];
    expect(job).toMatchObject({ state: 'failed', error: { code: 'invalid' } });
    await advance(120_000);
    expect(fe.server.requests('POST', '/api/requests/').filter((r) => r.path.endsWith('/messages'))).toHaveLength(1);
    await finish(api.discard(job?.id ?? ''));
    expect(api.getSnapshot().jobs).toHaveLength(0);
    expect(await mjobKeys(fe.dbName)).toHaveLength(0);
  });

  it('429: waits Retry-After with a friendly toast, then sends', async () => {
    const { api, threads, fe, s } = setup();
    await ready();
    const base = threads.handle;
    let limited = true;
    fe.server.override = (req) =>
      limited && req.method === 'POST' && req.path.endsWith('/messages')
        ? apiError(429, 'rate_limited', 'Too many messages. Wait a moment', { retryAfterSeconds: 10 })
        : base(req);
    await finish(api.send(ROW, 'One'));
    await advance(100);
    expect(s().toasts.map((t) => t.title)).toContain('Too many messages');
    expect(api.getSnapshot().jobs[0]?.state).toBe('pending');
    limited = false;
    await advance(10_500);
    expect(threads.messages.map((m) => m.body)).toEqual(['One']);
  });

  it('a reload finds the queued message and sends it once', async () => {
    const { api, threads, fe, stop } = setup();
    await ready();
    fe.setOnline(false);
    await finish(api.send(ROW, 'Queued before reload'));
    await settle();
    stop();
    const again = boot(fe.server, { dbName: fe.dbName });
    await ready();
    await advance(100);
    expect(threads.messages.map((m) => m.body)).toEqual(['Queued before reload']);
    expect((again.a.messages as MessagingApi).getSnapshot().jobs).toHaveLength(0);
  });

  it('never sends a job queued by another staff member', async () => {
    const { api, threads, fe, stop } = setup();
    await ready();
    fe.setOnline(false);
    await finish(api.send(ROW, 'From Dana'));
    stop();
    fe.server.session = { ...STAFF.sam, role: 'staff', eventId: STUB_EVENT.id, event: STUB_EVENT, expiresAt: '2026-11-07T15:00:00.000000+00:00' };
    const sam = boot(fe.server, { dbName: fe.dbName });
    await ready();
    await advance(10_000);
    expect(threads.posts).toBe(0);
    expect((sam.a.messages as MessagingApi).getSnapshot().jobs).toHaveLength(1);
    expect(await finish(sam.a.signOut())).toMatchObject({ ok: false, reason: 'outbox', count: 0, messages: 1 });
  });
});

describe('read, en route and the alert', () => {
  it('marks the thread read up to its newest message and clears the badge at once', async () => {
    const other = { by: 'Rae C.', mine: false, text: 'Any tattoos or marks?' };
    const row = makeRow(1, { messageCount: 1, unread: 1, lastMessage: other, lastMessageAt: '2026-11-07T03:00:30.000000+00:00', needsInfo: true, enroute: null, involved: true });
    const { api, threads, s } = setup([row]);
    threads.messages.push({ id: '00000000-0000-4000-8000-0000000000aa', requestId: ROW, staff: STAFF.rae.staff, by: 'Rae C.', team: 'Medical', body: 'Any tattoos or marks?', createdAt: '2026-11-07T03:00:30.000000+00:00', mine: false, clientMutationId: 'c1' });
    await ready();
    const close = api.open(ROW);
    await advance(100);
    api.markRead(ROW);
    await advance(50);
    expect(threads.reads).toEqual([{ requestId: ROW, upto: '2026-11-07T03:00:30.000000+00:00' }]);
    expect(s().confirmed.get(ROW)?.unread).toBe(0);
    api.markRead(ROW);
    await advance(50);
    expect(threads.reads).toHaveLength(1);
    close();
  });

  it('en route queued offline keeps the time of the tap; cancel offers Undo that puts the ETA back', async () => {
    const row = makeRow(1, { status: STATUS.inMedical });
    const { api, threads, fe, s, a } = setup([row]);
    await ready();
    fe.setOnline(false);
    await finish(api.setEnroute(ROW, 'set', 5));
    await advance(60_000);
    fe.setOnline(true);
    fe.fire('window', 'online');
    await advance(100);
    expect(threads.enroute.get(ROW)).toMatchObject({ etaMinutes: 5, state: 'enroute' });
    expect(threads.enroute.get(ROW)?.queuedMs).toBeGreaterThanOrEqual(60_000);
    await finish(api.cancelEnroute(ROW, { etaAt: '2026-11-07T03:06:00.000000+00:00', etaMinutes: 5 }));
    await advance(50);
    expect(threads.enroute.get(ROW)?.state).toBe('none');
    expect(s().snackbar?.message).toBe('En route cancelled');
    await finish(a.undo(s().snackbar?.id ?? ''));
    await advance(50);
    expect(threads.enroute.get(ROW)).toMatchObject({ state: 'enroute', etaAt: '2026-11-07T03:06:00.000000+00:00', etaMinutes: 5 });
  });

  it('an en route tap that keeps failing stays on screen as "Not delivered" until Retry, a new tap or Delete', async () => {
    const row = makeRow(1, { status: STATUS.inMedical });
    const { api, threads, fe, s } = setup([row]);
    await ready();
    const base = threads.handle;
    let failing = true;
    fe.server.override = (req) => (failing && req.method === 'POST' && req.path.endsWith('/enroute') ? apiError(503, 'unavailable', 'Down') : base(req));
    const shown = () => effectiveEnroute(s().confirmed.get(ROW)?.enroute ?? null, api.getSnapshot().jobs, 0);
    await finish(api.setEnroute(ROW, 'set', 5));
    await advance(100);
    expect(shown()).toMatchObject({ count: 1, state: 'enroute', mine: { etaMinutes: 5 } });
    await advance(100_000);
    const posts = () => fe.server.requests('POST', '/api/requests/').filter((r) => r.path.endsWith('/enroute')).length;
    expect(posts()).toBe(3);
    const failed = failedEnrouteTap(api.getSnapshot().jobs);
    expect(failed).toMatchObject({ state: 'failed', error: { message: 'Not delivered' } });
    // What I asked for stays (never a silent drop back to the En route button), and sign-out knows about it.
    expect(shown()).toMatchObject({ count: 1, state: 'enroute', mine: { etaMinutes: 5 } });
    expect(api.unsentCount()).toBe(1);
    // Retry sends it.
    failing = false;
    api.retry(failed?.id ?? '');
    await advance(100);
    expect(threads.enroute.get(ROW)).toMatchObject({ state: 'enroute', etaMinutes: 5 });
    expect(api.getSnapshot().jobs).toHaveLength(0);

    // A new tap replaces one that was not delivered; Delete forgets one.
    failing = true;
    await finish(api.setEnroute(ROW, 'arrive', null));
    await advance(100_000);
    expect(failedEnrouteTap(api.getSnapshot().jobs)?.enroute?.action).toBe('arrive');
    expect(shown()).toMatchObject({ state: 'arrived' });
    await finish(api.setEnroute(ROW, 'set', 10));
    await advance(10);
    expect(api.getSnapshot().jobs.filter((j) => j.enroute?.action === 'arrive')).toHaveLength(0);
    await advance(100_000);
    const again = failedEnrouteTap(api.getSnapshot().jobs);
    expect(again?.enroute).toMatchObject({ action: 'set', etaMinutes: 10 });
    await finish(api.discard(again?.id ?? ''));
    expect(api.getSnapshot().jobs).toHaveLength(0);
    expect(await mjobKeys(fe.dbName)).toHaveLength(0);
    expect(shown()).toMatchObject({ state: 'enroute', mine: { etaMinutes: 5 } });
  });

  it('a synced new message from someone else on my request toasts once (never on the first sync)', async () => {
    const row = makeRow(1, { createdBy: STAFF.dana.staff, messageCount: 0, unread: 0, lastMessage: null, lastMessageAt: null, needsInfo: false, enroute: null, involved: true });
    const { fe, s } = setup([row]);
    await ready();
    expect(s().toasts).toHaveLength(0);
    fe.server.put({ ...row, messageCount: 1, unread: 1, lastMessageAt: '2026-11-07T03:01:00.000000+00:00', lastMessage: { by: 'Rae C.', mine: false, text: 'Any tattoos or marks?' } });
    await advance(7_000);
    const toast = s().toasts.find((t) => t.subtitle === 'Rae C.: Any tattoos or marks?');
    expect(toast).toBeTruthy();
    expect(toast?.title).not.toMatch(/LP-/);
    await advance(7_000);
    expect(s().toasts.filter((t) => t.subtitle === 'Rae C.: Any tattoos or marks?')).toHaveLength(1);
  });

  it('regression: a row cached by the build before messages (no activity fields) toasts its first message after the update', async () => {
    const plain = makeRow(1, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([plain]);
    const first = boot(server);
    await ready();
    await advance(3_500);
    first.stop();
    // The cache as the old build left it, with a cursor well inside the 6 h full-fetch window.
    await openKv(first.fe.dbName)?.set(K.rows(STUB_EVENT.id, canonStaff(STAFF.dana.staff) ?? ''), [plain]);
    server.overlap = 0; // the delta resends nothing: the cached row stays without activity
    const second = boot(server, { dbName: first.fe.dbName });
    await ready();
    expect(server.requests('GET', '/api/sync').at(-1)?.query.get('since')).not.toBeNull();
    expect(second.s().confirmed.get(plain.id)?.messageCount).toBeUndefined();
    server.put({ ...plain, messageCount: 1, unread: 1, lastMessageAt: '2026-11-07T03:01:00.000000+00:00', lastMessage: { by: 'Rae C.', mine: false, text: 'Any tattoos or marks?' }, needsInfo: true, enroute: null, involved: true });
    await advance(7_000);
    expect(second.s().confirmed.get(plain.id)?.messageCount).toBe(1);
    expect(second.s().toasts.filter((t) => t.subtitle === 'Rae C.: Any tattoos or marks?')).toHaveLength(1);
  });
});

describe('sign-out', () => {
  it('is refused while messages are queued; discarding deletes them from the phone', async () => {
    const { api, fe, a } = setup();
    await ready();
    fe.setOnline(false);
    await finish(api.send(ROW, 'Not sent yet'));
    expect(await finish(a.signOut())).toEqual({ ok: false, reason: 'outbox', count: 0, messages: 1 });
    fe.setOnline(true);
    const done = await finish(a.signOut({ discardOutbox: true }), 1_000);
    expect(done).toEqual({ ok: true });
    await settle();
    expect(await mjobKeys(fe.dbName)).toHaveLength(0);
    expect(api.getSnapshot().threads.size).toBe(0);
  });
});

describe('the engine is never on the boot or sign-out path', () => {
  const NEVER = () => new Promise<typeof createMessaging>(() => undefined);
  const syncs = (server: FakeServer) => server.requests('GET', '/api/sync').length;

  it('the first sync and the queued requests go while the engine is still downloading (it never arrives)', async () => {
    const server = new FakeServer([makeRow(1)]);
    const first = boot(server);
    await ready();
    first.fe.setOnline(false);
    await finish(first.a.create({ values: values(), clientMutationId: '00000000-0000-4000-8000-0000000000c1', photos: [], photoTiming: 'today' }));
    first.stop();
    await settle();
    server.log.length = 0;
    const second = boot(server, { dbName: first.fe.dbName, loadMessaging: NEVER });
    await ready();
    await advance(1_000);
    expect(syncs(server)).toBeGreaterThanOrEqual(1);
    expect(second.s().confirmed.size).toBeGreaterThanOrEqual(1);
    expect(server.requests('POST', '/api/requests').filter((r) => r.path === '/api/requests')).toHaveLength(1);
    expect(second.s().outbox).toHaveLength(0);
  });

  it('sign-out counts saved messages from the phone without the engine, and never hangs', async () => {
    const { api, fe, stop } = setup();
    await ready();
    fe.setOnline(false);
    await finish(api.send(ROW, 'Not sent yet'));
    stop();
    await settle();
    const again = boot(fe.server, { dbName: fe.dbName, loadMessaging: NEVER });
    await ready();
    expect(await finish(again.a.signOut())).toEqual({ ok: false, reason: 'outbox', count: 0, messages: 1 });
    const none = boot(new FakeServer([makeRow(1)]), { loadMessaging: NEVER });
    await ready();
    expect(await finish(none.a.signOut(), 1_000)).toEqual({ ok: true });
  });

  it('a message saved before a failed boot load is read and sent once the engine loads later', async () => {
    const { api, threads, fe, stop } = setup();
    await ready();
    fe.setOnline(false);
    await finish(api.send(ROW, 'Queued, then the app reopened offline'));
    stop();
    await settle();
    let loads = 0;
    const flaky = () => {
      loads += 1;
      return loads <= 2 ? Promise.reject(new Error('chunk failed')) : Promise.resolve(createMessaging);
    };
    const again = boot(fe.server, { dbName: fe.dbName, loadMessaging: flaky });
    again.fe.setOnline(false);
    await ready();
    expect(threads.posts).toBe(0);
    again.fe.setOnline(true);
    again.fe.fire('window', 'online');
    await advance(10_000);
    expect(loads).toBe(3);
    expect(threads.posts).toBe(1);
    expect(threads.messages.map((m) => m.body)).toEqual(['Queued, then the app reopened offline']);
    expect((again.a.messages as MessagingApi).getSnapshot().jobs).toHaveLength(0);
    expect(await mjobKeys(fe.dbName)).toHaveLength(0);
  });
});

// (network fix 4, 2026-11-08) A phone unlocked on a request page: the thread is polled the moment the page is visible
// again (in parallel with the resume sync), not at the next 6 s tick or after the sync's lastMessageAt refresh.
describe('an open thread when the page comes back into view (fix 4)', () => {
  const doc = new EventTarget();
  beforeEach(() => {
    vi.stubGlobal('document', doc);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const threadGets = (server: FakeServer) => server.requests('GET', `/api/requests/${ROW}/messages`).filter((r) => r.path.endsWith('/messages')).length;
  /** Hidden (the thread poll pauses with the page), then back: the store and the engine hear visibilitychange. */
  const away = (fe: ReturnType<typeof setup>['fe']) => {
    fe.setVisible(false);
    fe.fire('document', 'visibilitychange');
    doc.dispatchEvent(new Event('visibilitychange'));
  };
  const back = (fe: ReturnType<typeof setup>['fe']) => {
    fe.setVisible(true);
    fe.fire('document', 'visibilitychange');
    doc.dispatchEvent(new Event('visibilitychange'));
  };

  it('hidden → visible with an open thread: one GET of its messages at once, with the message sent meanwhile', async () => {
    const { api, threads, fe, server } = setup();
    await ready();
    const close = api.open(ROW);
    await advance(50);
    away(fe);
    await advance(60_000); // locked: the 6 s ticks skip a hidden page
    threads.messages.push({ id: '00000000-0000-4000-8000-0000000000aa', requestId: ROW, staff: STAFF.rae.staff, by: 'Rae C.', team: 'Medical', body: 'Found her at Bed 3', createdAt: server.stamp(5000), mine: false, clientMutationId: '00000000-0000-4000-8000-0000000000ab' });
    const before = threadGets(server);
    back(fe);
    await advance(20); // well before the next tick and the sync's own refresh
    expect(threadGets(server)).toBe(before + 1);
    expect(api.getSnapshot().threads.get(ROW)?.messages.map((m) => m.body)).toContain('Found her at Bed 3');
    // The next tick skips a thread loaded under 5.5 s ago.
    const after = threadGets(server);
    await advance(5_000);
    expect(threadGets(server)).toBe(after);
    close();
  });

  it('no GET when the thread was loaded under 5.5 s ago, when offline, or after stop()', async () => {
    const { api, fe, server, stop } = setup();
    await ready();
    const close = api.open(ROW);
    await advance(50);
    // A glance away and back within a second: loaded just now, not fetched again.
    away(fe);
    await advance(1_000);
    let before = threadGets(server);
    back(fe);
    await advance(20);
    expect(threadGets(server)).toBe(before);
    // Offline: nothing.
    away(fe);
    await advance(60_000);
    fe.setOnline(false);
    fe.fire('window', 'offline');
    before = threadGets(server);
    back(fe);
    await advance(20);
    expect(threadGets(server)).toBe(before);
    close();
    // Stopped: the listener is gone.
    stop();
    await advance(60_000);
    fe.setOnline(true);
    before = threadGets(server);
    doc.dispatchEvent(new Event('visibilitychange'));
    await advance(20);
    expect(threadGets(server)).toBe(before);
  });

  // (network fix 4 follow-up) The thread GET goes out at once, but its answer (the cookie's view: `mine`, receipt,
  // unread) is applied only once the resume's session check confirmed the same staff.
  it('another staff signed in meanwhile: their view of the thread never shows or is cached as the previous staff', async () => {
    const { api, threads, fe, server, s } = setup();
    await ready();
    const close = api.open(ROW);
    await advance(50);
    away(fe);
    await advance(60_000);
    server.session = { ...STAFF.rae, role: 'staff', eventId: STUB_EVENT.id, event: STUB_EVENT, expiresAt: '2026-11-07T15:00:00.000000+00:00' };
    // Rae's own message, as Rae's cookie sees it.
    threads.messages.push({ id: '00000000-0000-4000-8000-0000000000ba', requestId: ROW, staff: STAFF.rae.staff, by: 'Rae C.', team: 'Medical', body: 'from rae', createdAt: server.stamp(5000), mine: true, clientMutationId: '00000000-0000-4000-8000-0000000000bb' });
    const base = threads.handle;
    server.override = async (req) => {
      if (req.path === '/api/session') await new Promise((r) => setTimeout(r, 1_500)); // a congested link
      return base(req);
    };
    const before = threadGets(server);
    back(fe);
    await advance(200);
    // The GET went out at once; nothing of it is applied while the check is out.
    expect(threadGets(server)).toBe(before + 1);
    expect(s().session.staffName).toBe(STAFF.dana.staffName);
    expect(api.getSnapshot().threads.get(ROW)?.messages.map((m) => m.body) ?? []).not.toContain('from rae');
    await advance(2_000);
    expect(s().session.staffName).toBe(STAFF.rae.staffName);
    const danaThread = await openKv(fe.dbName)?.get<{ messages: ThreadMessage[] }>(`cache:edco26:${canonStaff(STAFF.dana.staff)}:thread:${ROW}`);
    expect((danaThread?.messages ?? []).map((m) => m.body)).not.toContain('from rae');
    expect(threads.reads).toEqual([]);
    close();
  });

  it('the same staff: the thread lands as soon as both the GET and the check are back (no extra session GET)', async () => {
    const { api, threads, fe, server } = setup();
    await ready();
    const close = api.open(ROW);
    await advance(50);
    away(fe);
    await advance(60_000);
    threads.messages.push({ id: '00000000-0000-4000-8000-0000000000ca', requestId: ROW, staff: STAFF.rae.staff, by: 'Rae C.', team: 'Medical', body: 'Found her at Bed 3', createdAt: server.stamp(5000), mine: false, clientMutationId: '00000000-0000-4000-8000-0000000000cb' });
    const base = threads.handle;
    server.override = async (req) => {
      if (req.path === '/api/session') await new Promise((r) => setTimeout(r, 300));
      return base(req);
    };
    const sessions = server.requests('GET', '/api/session').length;
    back(fe);
    await advance(200);
    expect(api.getSnapshot().threads.get(ROW)?.messages.map((m) => m.body)).not.toContain('Found her at Bed 3');
    await advance(200);
    expect(api.getSnapshot().threads.get(ROW)?.messages.map((m) => m.body)).toContain('Found her at Bed 3');
    expect(server.requests('GET', '/api/session').length).toBe(sessions + 1);
    close();
  });
});

