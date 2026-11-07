// lib/client/activity-client.ts (F4, spec §18 A56): the bell's unread count from sync, and the ids or the open
// list fetched only when the sync's Activity fingerprint (activityKey) moves (a poll stays small), so an open
// list follows every new event; read state per request (opening it marks it read; opening the sheet does
// not), Mark all read with Undo, the app icon badge (cleared at the first sync when nothing is unread), and
// sign-out. Synthetic ids only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityRow } from '@/lib/activity';
import { createActivityClient } from '@/lib/client/activity-client';
import { publishSyncExtras } from '@/lib/client/f4-bridge';
import { apiRequest } from '@/lib/client/http';

const A = '0f0f0f0f-0000-4000-8000-0000000000a1';
const B = '0f0f0f0f-0000-4000-8000-0000000000b2';
const C = '0f0f0f0f-0000-4000-8000-0000000000c3';

const row = (requestId: string, read: boolean, at = '2026-11-06T21:00:00Z', detail = 'In medical'): ActivityRow => ({ requestId, kind: 'in_medical', title: 'J.D.', detail, at, read });

function fakeServer() {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  let rows: ActivityRow[] = [row(A, false), row(B, false, '2026-11-06T20:00:00Z'), row(C, true, '2026-11-06T19:00:00Z')];
  let fail = false;
  let holdReads = false;
  const held: Array<() => void> = [];
  const unreadIds = () => rows.filter((r) => !r.read).map((r) => r.requestId);
  // The fingerprint the sync carries: it moves with any row added, changed or read.
  const key = () => JSON.stringify(rows).length.toString(16).padStart(4, '0') + rows.map((r) => `${r.requestId.slice(-2)}${r.read ? 1 : 0}${r.at.slice(11, 16)}${r.detail.length}`).join('');
  const fetch = async (path: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body });
    const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (fail) return json({ error: { code: 'unavailable', message: 'x' } }, 503);
    if (path === '/api/activity') return json({ serverTime: '2026-11-06T21:30:00Z', rows });
    if (path === '/api/activity/read') {
      if (holdReads) await new Promise<void>((r) => held.push(r));
      const ids = body && 'all' in body ? unreadIds() : rows.filter((r) => !r.read && r.requestId === body?.requestId).map((r) => r.requestId);
      rows = rows.map((r) => (ids.includes(r.requestId) ? { ...r, read: true } : r));
      return json({ count: ids.length, ids });
    }
    if (path === '/api/activity/unread' && method === 'GET') return json({ count: unreadIds().length, ids: unreadIds(), key: key() });
    if (path === '/api/activity/unread') {
      const ids = (body?.requestIds as string[]) ?? [];
      rows = rows.map((r) => (ids.includes(r.requestId) ? { ...r, read: false } : r));
      return json({ count: ids.length });
    }
    return json({ error: { code: 'not_found', message: 'x' } }, 404);
  };
  return {
    calls,
    fetch,
    setFail: (f: boolean) => (fail = f),
    setRows: (r: ActivityRow[]) => (rows = r),
    holdReads: (on: boolean) => {
      holdReads = on;
      if (!on) held.splice(0).forEach((r) => r());
    },
    /** What the first page of a poll carries now. */
    sync: () => (unreadIds().length > 0 ? { activityUnread: unreadIds().length, activityKey: key() } : { activityUnread: 0 }),
    gets: (path: string) => calls.filter((c) => c.path === path && c.method === 'GET').length,
  };
}

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

let server: ReturnType<typeof fakeServer>;
let badges: number[];

beforeEach(() => {
  publishSyncExtras(null);
  server = fakeServer();
  badges = [];
});
afterEach(() => publishSyncExtras(null));

const make = () => {
  // Each client its own badge log (clients of earlier tests still listen to sync).
  const mine: number[] = [];
  badges = mine;
  return createActivityClient({ request: (path, opts) => apiRequest(server.fetch, path, opts), setBadge: (n) => mine.push(n) });
};

describe('the bell', () => {
  it('counts unread requests from sync, fetches the ids when the key moves, and the app icon badge follows', async () => {
    const client = make();
    client.start();
    publishSyncExtras(server.sync());
    expect(client.getState().unread).toBe(2);
    expect(badges.at(-1)).toBe(2);
    await settle();
    expect([...client.getState().unreadIds]).toEqual([A, B]);
    expect(server.gets('/api/activity/unread')).toBe(1);
    server.setRows([row(A, true), row(B, true, '2026-11-06T20:00:00Z'), row(C, true, '2026-11-06T19:00:00Z')]);
    publishSyncExtras(server.sync());
    expect(client.getState().unread).toBe(0);
    expect(badges.at(-1)).toBe(0);
    await settle();
    expect(client.getState().unreadIds.size).toBe(0);
  });

  it('a poll whose key did not move fetches nothing (a poll stays small)', async () => {
    const client = make();
    client.start();
    publishSyncExtras(server.sync());
    await settle();
    for (let i = 0; i < 5; i += 1) publishSyncExtras(server.sync());
    await settle();
    expect(server.gets('/api/activity/unread')).toBe(1);
    expect(server.gets('/api/activity')).toBe(0);
  });

  it('regression: a badge left on the icon by an earlier push is cleared at the first sync with nothing unread', async () => {
    server.setRows([]);
    const client = make();
    client.start();
    publishSyncExtras(server.sync());
    publishSyncExtras(server.sync());
    await settle();
    expect(badges).toEqual([0]);
  });

  it('a value published before anyone listened is the starting point; an older server changes nothing', async () => {
    publishSyncExtras(server.sync());
    const client = make();
    client.start();
    expect(client.getState().unread).toBe(2);
    publishSyncExtras({});
    await settle();
    expect(client.getState().unread).toBe(2);
  });

  it('a failed ids fetch is tried again at the next sync', async () => {
    const client = make();
    client.start();
    server.setFail(true);
    publishSyncExtras(server.sync());
    await settle();
    server.setFail(false);
    publishSyncExtras(server.sync());
    await settle();
    expect([...client.getState().unreadIds]).toEqual([A, B]);
  });
});

describe('the list', () => {
  it('everything read on another device while the list is open (the poll says 0, no key): its rows turn read', async () => {
    const client = make();
    client.start();
    publishSyncExtras(server.sync());
    client.setOpen(true);
    await settle();
    expect(client.getState().unread).toBe(2);
    server.setRows([row(A, true), row(B, true, '2026-11-06T20:00:00Z'), row(C, true, '2026-11-06T19:00:00Z')]);
    publishSyncExtras(server.sync());
    await settle();
    expect(client.getState().unread).toBe(0);
    expect(client.getState().unreadIds.size).toBe(0);
    expect(client.getState().rows?.every((r) => r.read)).toBe(true);
  });

  it('loads when the sheet opens; opening it marks nothing read', async () => {
    const client = make();
    client.start();
    client.setOpen(true);
    await settle();
    expect(client.getState().rows?.map((r) => r.requestId)).toEqual([A, B, C]);
    expect(client.getState().unread).toBe(2);
    expect(server.calls.filter((c) => c.path === '/api/activity/read')).toHaveLength(0);
  });

  it('refetches when the unread set changes while it is open', async () => {
    const client = make();
    client.start();
    publishSyncExtras(server.sync());
    client.setOpen(true);
    await settle();
    const before = server.gets('/api/activity');
    server.setRows([row(C, false, '2026-11-06T21:20:00Z'), row(A, false), row(B, false)]);
    publishSyncExtras(server.sync());
    await settle();
    expect(server.gets('/api/activity')).toBe(before + 1);
    expect(client.getState().rows?.[0]?.requestId).toBe(C);
  });

  it('regression: a new event on a request that is already unread reaches the open list (same unread set)', async () => {
    const client = make();
    client.start();
    publishSyncExtras(server.sync());
    client.setOpen(true);
    await settle();
    expect(client.getState().rows?.[0]?.detail).toBe('In medical');
    // Medical sets the location of A: still unread, so the unread set is unchanged, but its row is new.
    server.setRows([row(A, false, '2026-11-06T21:25:00Z', 'In medical · Bed 3'), row(B, false, '2026-11-06T20:00:00Z'), row(C, true, '2026-11-06T19:00:00Z')]);
    publishSyncExtras(server.sync());
    await settle();
    expect(client.getState().rows?.[0]).toMatchObject({ requestId: A, detail: 'In medical · Bed 3' });
  });

  it('offline: says so instead of an endless spinner', async () => {
    server.setFail(true);
    const client = make();
    client.start();
    client.setOpen(true);
    await settle();
    expect(client.getState()).toMatchObject({ rows: null, failed: true, loading: false });
  });
});

describe('read state belongs to the request', () => {
  it('opening a request marks its row read (only once, only when unread)', async () => {
    const client = make();
    client.start();
    publishSyncExtras(server.sync());
    await settle();
    client.markRead(A);
    client.markRead(A);
    client.markRead(C); // not unread: nothing sent
    await settle();
    const reads = server.calls.filter((c) => c.path === '/api/activity/read');
    expect(reads).toEqual([{ path: '/api/activity/read', method: 'POST', body: { requestId: A } }]);
    expect(client.getState().unread).toBe(1);
    expect(badges.at(-1)).toBe(1);
  });

  it('a sync that still lists it while the POST is on its way does not bring it back', async () => {
    const client = make();
    client.start();
    publishSyncExtras(server.sync());
    await settle();
    server.holdReads(true);
    client.markRead(A);
    // Another event elsewhere moves the key while the read is still on its way: the server still lists A.
    server.setRows([row(A, false), row(B, false, '2026-11-06T20:00:00Z'), row(C, false, '2026-11-06T21:10:00Z')]);
    publishSyncExtras(server.sync());
    await settle();
    expect(client.getState().unreadIds.has(A)).toBe(false);
    expect(client.getState().unread).toBe(2);
    server.holdReads(false);
    await settle();
  });
});

describe('Mark all read and Undo', () => {
  it('marks every row read, answers the ids, and Undo makes exactly those unread again', async () => {
    const client = make();
    client.start();
    client.setOpen(true);
    await settle();
    const ids = await client.markAllRead();
    expect(ids?.sort()).toEqual([A, B].sort());
    expect(client.getState().unread).toBe(0);
    expect(client.getState().rows?.every((r) => r.read)).toBe(true);
    expect(await client.undoMarkAll(ids ?? [])).toBe(true);
    expect(client.getState().unread).toBe(2);
    expect(client.getState().rows?.filter((r) => !r.read).map((r) => r.requestId).sort()).toEqual([A, B].sort());
    expect(server.calls.at(-1)).toMatchObject({ path: '/api/activity/unread', body: { requestIds: ids } });
  });

  it('a failed Mark all read puts the rows back', async () => {
    const client = make();
    client.start();
    client.setOpen(true);
    await settle();
    server.setFail(true);
    expect(await client.markAllRead()).toBeNull();
    expect(client.getState().unread).toBe(2);
  });
});

describe('sign-out', () => {
  it('forgets everything and clears the badge', async () => {
    const client = make();
    client.start();
    client.setOpen(true);
    await settle();
    client.reset();
    expect(client.getState()).toMatchObject({ unread: 0, rows: null, open: false });
    expect(badges.at(-1)).toBe(0);
  });
});
