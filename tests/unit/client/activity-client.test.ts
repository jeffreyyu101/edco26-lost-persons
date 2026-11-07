// lib/client/activity-client.ts (F4, spec §18 A56): the bell's unread count from sync, the list when the sheet
// opens (and again when the unread set changes while open), read state per request (opening it marks it read;
// opening the sheet does not), Mark all read with Undo, the app icon badge, and sign-out. Synthetic ids only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityRow } from '@/lib/activity';
import { createActivityClient } from '@/lib/client/activity-client';
import { publishSyncExtras, resetSyncExtras } from '@/lib/client/sync-extras';

const A = '0f0f0f0f-0000-4000-8000-0000000000a1';
const B = '0f0f0f0f-0000-4000-8000-0000000000b2';
const C = '0f0f0f0f-0000-4000-8000-0000000000c3';

const row = (requestId: string, read: boolean, at = '2026-11-06T21:00:00Z'): ActivityRow => ({ requestId, kind: 'in_medical', title: 'J.D.', detail: 'In medical', at, read });

function fakeServer() {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  let rows: ActivityRow[] = [row(A, false), row(B, false, '2026-11-06T20:00:00Z'), row(C, true, '2026-11-06T19:00:00Z')];
  let fail = false;
  const fetch = async (path: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ path, method: init?.method ?? 'GET', body });
    const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (fail) return json({ error: { code: 'unavailable', message: 'x' } }, 503);
    if (path === '/api/activity') return json({ serverTime: '2026-11-06T21:30:00Z', rows });
    if (path === '/api/activity/read') {
      const ids = body && 'all' in body ? rows.filter((r) => !r.read).map((r) => r.requestId) : rows.filter((r) => !r.read && r.requestId === body?.requestId).map((r) => r.requestId);
      rows = rows.map((r) => (ids.includes(r.requestId) ? { ...r, read: true } : r));
      return json({ count: ids.length, ids });
    }
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
  };
}

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

let server: ReturnType<typeof fakeServer>;
let badges: number[];

beforeEach(() => {
  resetSyncExtras();
  server = fakeServer();
  badges = [];
});
afterEach(() => resetSyncExtras());

const make = () => {
  // Each client its own badge log (clients of earlier tests still listen to sync).
  const mine: number[] = [];
  badges = mine;
  return createActivityClient({ fetch: server.fetch, setBadge: (n) => mine.push(n) });
};

describe('the bell', () => {
  it('counts unread requests from sync, and the app icon badge follows', () => {
    const client = make();
    client.start();
    publishSyncExtras({ activityUnread: 2, activityUnreadIds: [A, B] });
    expect(client.getState().unread).toBe(2);
    expect([...client.getState().unreadIds]).toEqual([A, B]);
    expect(badges.at(-1)).toBe(2);
    publishSyncExtras({ activityUnread: 0, activityUnreadIds: [] });
    expect(client.getState().unread).toBe(0);
    expect(badges.at(-1)).toBe(0);
  });

  it('a value published before anyone listened is the starting point; an older server changes nothing', () => {
    publishSyncExtras({ activityUnread: 1, activityUnreadIds: [A] });
    const client = make();
    client.start();
    expect(client.getState().unread).toBe(1);
    publishSyncExtras({});
    expect(client.getState().unread).toBe(1);
  });
});

describe('the list', () => {
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
    client.setOpen(true);
    await settle();
    const before = server.calls.filter((c) => c.path === '/api/activity').length;
    server.setRows([row(C, false, '2026-11-06T21:20:00Z'), row(A, false), row(B, false)]);
    publishSyncExtras({ activityUnread: 3, activityUnreadIds: [C, A, B] });
    await settle();
    expect(server.calls.filter((c) => c.path === '/api/activity').length).toBe(before + 1);
    expect(client.getState().rows?.[0]?.requestId).toBe(C);
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
    publishSyncExtras({ activityUnread: 2, activityUnreadIds: [A, B] });
    client.markRead(A);
    client.markRead(A);
    client.markRead(C); // not unread: nothing sent
    await settle();
    const reads = server.calls.filter((c) => c.path === '/api/activity/read');
    expect(reads).toEqual([{ path: '/api/activity/read', method: 'POST', body: { requestId: A } }]);
    expect(client.getState().unread).toBe(1);
    expect(badges.at(-1)).toBe(1);
  });

  it('a sync that still lists it while the POST is on its way does not bring it back', () => {
    const client = make();
    client.start();
    publishSyncExtras({ activityUnread: 2, activityUnreadIds: [A, B] });
    client.markRead(A);
    publishSyncExtras({ activityUnread: 2, activityUnreadIds: [A, B] });
    expect(client.getState().unread).toBe(1);
    expect(client.getState().unreadIds.has(A)).toBe(false);
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
