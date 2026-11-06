import { expect, type APIRequestContext } from '@playwright/test';

interface SyncPage<Row> {
  rows: Row[];
  hasMore?: boolean;
  next?: { at: string; id: string } | null;
}

/**
 * Every row through GET /api/sync, following its pages (A7: 500 rows a page) the way the store does. The
 * shared local database keeps every run's synthetic rows, so a first page alone soon misses new ones.
 */
export async function syncRows<Row>(request: APIRequestContext): Promise<Row[]> {
  const rows: Row[] = [];
  let after: { at: string; id: string } | null = null;
  for (let page = 0; page < 100; page += 1) {
    const qs = new URLSearchParams();
    if (after) {
      qs.set('afterAt', after.at);
      qs.set('afterId', after.id);
    }
    const res = await request.get(`/api/sync${after ? `?${qs.toString()}` : ''}`);
    expect(res.ok(), `GET /api/sync → ${res.status()}`).toBe(true);
    const body = (await res.json()) as SyncPage<Row>;
    rows.push(...body.rows);
    if (!body.hasMore || !body.next) return rows;
    after = body.next;
  }
  throw new Error('GET /api/sync: too many pages');
}
