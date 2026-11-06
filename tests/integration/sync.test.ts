// GET /api/sync (spec §6, A7, A37): full, delta, keyset paging, reconcile versions, ?ids=, '+' cursors,
// the delayed-commit overlap, the allowlist, validation and auth.
import { describe, expect, it } from 'vitest';
import type { SyncResponse } from '@/lib/api-types';
import { syncPath } from '@/lib/client/api-paths';
import { REQUEST_SUMMARY_KEYS } from '@/lib/server/mappers';
import { admin, api, cookieFor, createRequest, newStaff, psql, psqlAsync, randomUUID, withTestServer } from './harness';

withTestServer();

const sync = async (path: string, cookie: string) => {
  const res = await api<SyncResponse>(path, { cookie });
  expect(res.status, res.text).toBe(200);
  return res.body;
};

async function totalRows(): Promise<number> {
  const { count, error } = await admin().from('patients').select('id', { count: 'exact', head: true });
  if (error) throw new Error(error.code);
  return count ?? 0;
}

/** The route's page size when no limit is given (app/api/sync/route.ts DEFAULT_PAGE). */
const FULL_PAGE = 500;

/**
 * Follows a full fetch's `next` cursor to the end and returns every row, the first page included. The shared
 * local stack keeps every agent's TEST rows, so it can hold more than one page.
 */
async function restOfFullFetch(first: SyncResponse, cookie: string): Promise<SyncResponse['rows']> {
  const rows = [...first.rows];
  let page = first;
  for (let i = 0; page.hasMore; i += 1) {
    expect(i).toBeLessThan(1_000);
    page = await sync(syncPath({ after: page.next }), cookie);
    rows.push(...page.rows);
  }
  return rows;
}

/** The ids a full fetch returns, followed to the last page. */
async function fullFetchIds(cookie: string): Promise<Set<string>> {
  return new Set((await restOfFullFetch(await sync('/api/sync', cookie), cookie)).map((r) => r.id));
}

describe('GET /api/sync', () => {
  it('full fetch: every row, allowlisted keys only, a microsecond database cursor, no-store', async () => {
    const cookie = await cookieFor(newStaff());
    const before = await totalRows();
    const res = await api<SyncResponse>('/api/sync', { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('etag')).toBeNull();
    const body = res.body;
    // One page of up to 500 rows; a bigger table pages on with next (exactly 500, next = the last row).
    if (body.hasMore) {
      expect(body.rows).toHaveLength(FULL_PAGE);
      expect(body.next?.id).toBe(body.rows.at(-1)?.id);
    } else {
      expect(body.rows.length).toBeLessThanOrEqual(FULL_PAGE);
      expect(body.next).toBeNull();
    }
    expect(body.versions).toBeUndefined();
    expect(body.serverTime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?[+-]\d\d:\d\d$/);
    const rows = await restOfFullFetch(body, cookie);
    const after = await totalRows();
    // Every row: rows are never deleted, so all `before` rows are there, and at most the ones other test
    // files created meanwhile on top (on a quiet database before = after, the exact count).
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBeGreaterThanOrEqual(before);
    expect(ids.size).toBeLessThanOrEqual(after);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(REQUEST_SUMMARY_KEYS);
    const seed = rows.find((r) => r.caseNumber === 1012);
    expect(seed).toMatchObject({ name: 'Kayla Martinez', postShort: 'FA 3', photoCount: 2, status: 'Added' });
  });

  it('delta: a change after the cursor shows up; only rows updated after since − 30 s are sent', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const first = await sync('/api/sync', cookie);
    const r = await createRequest(staff);
    const delta = await sync(syncPath({ since: first.serverTime }), cookie);
    expect(delta.rows.map((x) => x.id)).toContain(r.id);
    expect(Date.parse(delta.serverTime)).toBeGreaterThanOrEqual(Date.parse(first.serverTime));
    // Every delta row was updated after since − 30 s.
    for (const row of delta.rows) expect(Date.parse(row.updatedAt)).toBeGreaterThan(Date.parse(first.serverTime) - 30_000);
  });

  it('responses are never labelled with a Content-Encoding the body does not have (compression is the host\'s job)', async () => {
    const cookie = await cookieFor(newStaff());
    const res = await api('/api/sync', { cookie, headers: { 'accept-encoding': 'gzip, br' } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).rows.length).toBeGreaterThan(0);
  });

  it('an empty delta is about 100 bytes', async () => {
    const cookie = await cookieFor(newStaff());
    // A cursor far in the future: nothing can match, so this is exactly the empty-delta payload.
    const res = await api(syncPath({ since: '2099-01-01T00:00:00.000000+00:00' }), { cookie });
    expect(JSON.parse(res.text)).toMatchObject({ rows: [], hasMore: false, next: null });
    expect(res.text.length).toBeLessThan(120);
  });

  it("'+' cursors round-trip: encoded (syncPath) and raw (decoded as a space) both work (A37)", async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const first = await sync('/api/sync?ids=5eed0000-0000-4000-8000-000000001012', cookie);
    expect(first.serverTime).toContain('+');
    const r = await createRequest(staff);
    const encoded = await sync(syncPath({ since: first.serverTime }), cookie);
    expect(encoded.rows.map((x) => x.id)).toContain(r.id);
    const raw = await sync(`/api/sync?since=${first.serverTime}`, cookie);
    expect(raw.rows.map((x) => x.id)).toContain(r.id);
    // A negative offset is fine too.
    const shifted = new Date(Date.parse(first.serverTime) - 5 * 3600_000).toISOString().replace('Z', '').slice(0, 23);
    const negative = await sync(syncPath({ since: `${shifted}-05:00` }), cookie);
    expect(negative.rows.map((x) => x.id)).toContain(r.id);
  });

  it('keyset paging: pages of 5 cover the full fetch exactly, keeping the same since', async () => {
    const cookie = await cookieFor(newStaff());
    const full = await fullFetchIds(cookie);
    const seen: string[] = [];
    let after: SyncResponse['next'] = null;
    let pages = 0;
    let firstServerTime: string | null = null;
    for (;;) {
      const page = await sync(syncPath({ limit: 5, after }), cookie);
      firstServerTime ??= page.serverTime;
      pages += 1;
      expect(page.rows.length).toBeLessThanOrEqual(5);
      seen.push(...page.rows.map((r) => r.id));
      if (!page.hasMore) {
        expect(page.next).toBeNull();
        break;
      }
      expect(page.rows).toHaveLength(5);
      expect(page.next?.id).toBe(page.rows[4]?.id);
      after = page.next;
      // A runaway guard that grows with the shared stack (every agent's TEST rows stay in it).
      expect(pages).toBeLessThan(Math.ceil(full.size / 5) + 100);
    }
    const fullAfter = await fullFetchIds(cookie);
    expect(new Set(seen).size).toBe(seen.length);
    // The same rows as the full fetch: all of it, plus at most what other test files created during the walk
    // (on a quiet database full = fullAfter, so this is the exact match).
    const seenSet = new Set(seen);
    expect([...full].filter((id) => !seenSet.has(id))).toEqual([]);
    expect(seen.filter((id) => !fullAfter.has(id))).toEqual([]);
    // hasMore is exact (the function reads limit + 1 rows), so there is never a trailing empty page.
    expect(pages).toBe(Math.max(1, Math.ceil(seen.length / 5)));
    // next.at is a verbatim database timestamp that round-trips through the URL.
    expect(firstServerTime).toContain('+');
  });

  it('paging a delta keeps the same since', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const start = await sync('/api/sync?ids=5eed0000-0000-4000-8000-000000001012', cookie);
    const made = [];
    for (let i = 0; i < 3; i += 1) made.push((await createRequest(staff)).id);
    // The delta also re-sends everything updated in the 30 s before `since` (earlier tests), so page through
    // all of it.
    const ids: string[] = [];
    let after: SyncResponse['next'] = null;
    let done = false;
    for (let i = 0; i < 2_000 && !done; i += 1) {
      const page = await sync(syncPath({ since: start.serverTime, limit: 3, after }), cookie);
      ids.push(...page.rows.map((r) => r.id));
      done = !page.hasMore;
      after = page.next;
    }
    expect(done).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of made) expect(ids).toContain(id);
  });

  it('reconcile=1 adds [id, rowVersion] for every row', async () => {
    const cookie = await cookieFor(newStaff());
    const res = await sync(syncPath({ since: '2099-01-01T00:00:00+00:00', reconcile: true }), cookie);
    expect(res.rows).toEqual([]);
    expect(res.versions?.length).toBe(await totalRows());
    const lp1012 = res.versions?.find(([id]) => id === '5eed0000-0000-4000-8000-000000001012');
    expect(typeof lp1012?.[1]).toBe('number');
    const noReconcile = await sync(syncPath({ since: '2099-01-01T00:00:00+00:00' }), cookie);
    expect(noReconcile.versions).toBeUndefined();
  });

  it('?ids= returns exactly those rows (unknown ids are simply absent)', async () => {
    const cookie = await cookieFor(newStaff());
    const ids = ['5eed0000-0000-4000-8000-000000001012', '5eed0000-0000-4000-8000-000000001004', randomUUID()];
    const res = await sync(syncPath({ ids }), cookie);
    expect(res.rows.map((r) => r.id).sort()).toEqual(ids.slice(0, 2).sort());
    expect(res.hasMore).toBe(false);
  });

  it.each([
    ['bad since', '/api/sync?since=yesterday'],
    ['since without offset', '/api/sync?since=2026-11-06T10:00:00'],
    ['afterAt without afterId', '/api/sync?afterAt=2026-11-06T10%3A00%3A00%2B00%3A00'],
    ['bad afterId', '/api/sync?afterAt=2026-11-06T10%3A00%3A00%2B00%3A00&afterId=x'],
    ['limit 0', '/api/sync?limit=0'],
    ['limit 5000', '/api/sync?limit=5000'],
    ['reconcile=yes', '/api/sync?reconcile=yes'],
    ['ids with since', `/api/sync?ids=${'5eed0000-0000-4000-8000-000000001012'}&since=2026-11-06T10%3A00%3A00%2B00%3A00`],
    ['bad id', '/api/sync?ids=abc'],
    ['201 ids', `/api/sync?ids=${Array.from({ length: 201 }, () => randomUUID()).join(',')}`],
    ['unknown param', '/api/sync?foo=1'],
  ])('%s → 400', async (_label, path) => {
    const res = await api(path, { cookie: await cookieFor(newStaff()) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('200 ids is the maximum', async () => {
    const res = await api(`/api/sync?ids=${Array.from({ length: 200 }, () => randomUUID()).join(',')}`, { cookie: await cookieFor(newStaff()) });
    expect(res.status).toBe(200);
  });

  it('requires a session', async () => {
    expect((await api('/api/sync')).status).toBe(401);
  });

  it('delayed commit: an update committed after the poll by a transaction that wrote before it is still delivered', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const r = await createRequest(staff);
    const base = await sync(syncPath({ ids: [r.id] }), cookie);
    const v0 = base.rows[0]?.rowVersion ?? -1;

    // Connection A: update (updated_at = clock_timestamp() now), then hold the transaction open for 3 s.
    const writer = psqlAsync(
      `begin; update public.patients set hair = 'TEST-S delayed' where id = '${r.id}'; select pg_sleep(3); commit;`,
    );
    await new Promise((res) => setTimeout(res, 1_200));
    // Connection B (the API) polls while A is still open: the change is invisible, the cursor moves past it.
    const during = await sync(syncPath({ since: base.serverTime }), cookie);
    const seenDuring = during.rows.find((x) => x.id === r.id);
    expect(seenDuring === undefined || seenDuring.rowVersion === v0).toBe(true);
    const done = await writer.done;
    expect(done.code, done.out).toBe(0);

    // The next poll uses the cursor from DURING the open transaction and still gets the committed change.
    const after = await sync(syncPath({ since: during.serverTime }), cookie);
    const row = after.rows.find((x) => x.id === r.id);
    expect(row?.rowVersion).toBe(v0 + 1);
    expect(row?.hair).toBe('TEST-S delayed');
    // Sanity: the write's updated_at is earlier than the cursor it was delivered after.
    const updatedAt = psql(`select extract(epoch from updated_at) from public.patients where id = '${r.id}'`);
    expect(Number(updatedAt) * 1000).toBeLessThan(Date.parse(during.serverTime));
  }, 20_000);
});
