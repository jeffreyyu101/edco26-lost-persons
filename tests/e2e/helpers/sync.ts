import { expect, type APIRequestContext, type Page } from '@playwright/test';

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

/**
 * Taps an answer and waits for the server's answer to its POST /api/requests/<id>/status. A second Not found
 * tapped before then (within 500 ms of the hold showing) is the other half of a double tap, and the store drops
 * it (store-core setStatus); a test that taps both answers must let the first one land.
 */
export async function answerSaved(page: Page, id: string, tap: () => Promise<void>): Promise<void> {
  const path = `/api/requests/${id}/status`;
  const saved = page.waitForResponse((res) => new URL(res.url()).pathname === path && res.request().method() === 'POST', { timeout: 20_000 });
  await tap();
  expect((await saved).ok(), `POST ${path}`).toBe(true);
}
