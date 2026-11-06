// Sync cursors in URLs (spec A37): database cursors carry a '+' offset that a raw query string decodes as
// a space. syncPath() always encodes; syncQuerySchema also tolerates the unencoded form.
import { describe, expect, it } from 'vitest';
import { syncPath } from '@/lib/client/api-paths';
import { searchParamsToObject, syncCursorSchema, syncQuerySchema } from '@/lib/validation';

// Exactly what lp_sync returns as serverTime / next.at in a UTC session.
const CURSOR = '2026-11-06T23:10:04.123456+00:00';
const AFTER_AT = '2026-11-06T23:10:05.5+00:00';
const ID = '5eed0000-0000-4000-8000-000000001012';

/** What the route handler does: parse the query string of the path the client requested. */
const serverParse = (path: string) => {
  const url = new URL(path, 'http://localhost');
  return syncQuerySchema.safeParse(searchParamsToObject(url.searchParams));
};

describe('syncPath (client)', () => {
  it('round-trips a +00:00 cursor verbatim through the URL and the server schema', () => {
    const path = syncPath({ since: CURSOR });
    expect(path).toBe('/api/sync?since=2026-11-06T23%3A10%3A04.123456%2B00%3A00');
    const parsed = serverParse(path);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.since).toBe(CURSOR);
  });

  it('round-trips paging (same since, next.at / next.id), reconcile and limit', () => {
    const path = syncPath({ since: CURSOR, reconcile: true, after: { at: AFTER_AT, id: ID }, limit: 200 });
    const parsed = serverParse(path);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ since: CURSOR, reconcile: '1', afterAt: AFTER_AT, afterId: ID, limit: 200 });
  });

  it('builds a full fetch and an ids fetch', () => {
    expect(syncPath({})).toBe('/api/sync');
    expect(syncPath({ since: null, after: null })).toBe('/api/sync');
    expect(syncPath({ since: CURSOR, reconcile: false })).toBe(syncPath({ since: CURSOR }));
    const ids = syncPath({ ids: [ID, ID] });
    expect(serverParse(ids).data).toEqual({ ids: [ID, ID] });
  });

  it('a negative offset survives too', () => {
    const cursor = '2026-11-06T18:10:04.123456-05:00';
    expect(serverParse(syncPath({ since: cursor })).data?.since).toBe(cursor);
  });
});

describe('syncQuerySchema tolerance (server)', () => {
  it('restores a raw + that URLSearchParams decoded as a space', () => {
    // A client that interpolated the cursor without encoding: `/api/sync?since=${serverTime}`.
    const raw = serverParse(`/api/sync?since=${CURSOR}&afterAt=${AFTER_AT}&afterId=${ID}`);
    expect(new URL(`http://localhost/api/sync?since=${CURSOR}`).searchParams.get('since')).toBe(
      '2026-11-06T23:10:04.123456 00:00',
    );
    expect(raw.success).toBe(true);
    expect(raw.data?.since).toBe(CURSOR);
    expect(raw.data?.afterAt).toBe(AFTER_AT);
  });

  it('the restored value must still pass the strict ISO check (offset hh:mm)', () => {
    expect(syncCursorSchema.safeParse('2026-11-06T23:10:04.123456 0000').success).toBe(false);
    expect(syncCursorSchema.safeParse('2026-11-06T23:10:04.123456 00:00').data).toBe(CURSOR);
  });

  it('still rejects anything that is not a cursor', () => {
    expect(syncCursorSchema.safeParse('yesterday').success).toBe(false);
    expect(syncCursorSchema.safeParse('2026-11-06 23:10:04+00:00').success).toBe(false);
    expect(syncCursorSchema.safeParse('2026-11-06T23:10:04.123456  00:00').success).toBe(false);
    expect(syncCursorSchema.safeParse(`${CURSOR} 00:00`).success).toBe(false);
    expect(serverParse('/api/sync?since=2026-11-06T23:10:04.123456 99:00').success).toBe(false);
  });
});
