// API URLs with query strings, built with URLSearchParams so every value is encoded. Pure, no zod (this
// module is on the first-load path of `/`).
//
// Why: sync cursors from the database carry a '+' offset ("2026-11-06T23:10:04.123456+00:00"). Interpolated
// raw (`/api/sync?since=${serverTime}`), the '+' decodes as a space on the server. syncQuerySchema now
// tolerates that, but the client must not rely on it: always build sync URLs with syncPath().
import type { IsoDateTime } from '../api-types';

/** The keyset position of the next page: SyncResponse.next, verbatim. */
export interface SyncAfter {
  at: IsoDateTime;
  id: string;
}

export type SyncPathQuery =
  /** Specific rows (reconcile follow-up), ≤ 200 ids. Cannot be combined with anything else. */
  | { ids: readonly string[] }
  | {
      ids?: never;
      /** The cursor: the previous sync's `serverTime`, verbatim. Absent or null = full fetch. */
      since?: IsoDateTime | null;
      /** Every 10th poll (SYNC.reconcileEvery): ask for `versions`. */
      reconcile?: boolean;
      /** The previous page's `next` (when `hasMore`), verbatim; keep the SAME `since`. */
      after?: SyncAfter | null;
      /** Page size (server default 500, at most 1000). */
      limit?: number;
    };

/**
 * The GET /api/sync path for a query, e.g. syncPath({since: res.serverTime}) →
 * "/api/sync?since=2026-11-06T23%3A10%3A04.123456%2B00%3A00". Cursors are passed verbatim and URL-encoded.
 */
export function syncPath(query: SyncPathQuery): string {
  const params = new URLSearchParams();
  if (query.ids !== undefined) {
    params.set('ids', query.ids.join(','));
  } else {
    if (query.since) params.set('since', query.since);
    if (query.reconcile) params.set('reconcile', '1');
    if (query.after) {
      params.set('afterAt', query.after.at);
      params.set('afterId', query.after.id);
    }
    if (query.limit !== undefined) params.set('limit', String(query.limit));
  }
  const qs = params.toString();
  return qs ? `/api/sync?${qs}` : '/api/sync';
}

/** GET /api/photos/:id: a 302 to a short-lived signed URL. Lists and the profile use thumb, the viewer full. */
export function photoPath(id: string, size: 'thumb' | 'full'): string {
  return `/api/photos/${encodeURIComponent(id)}?size=${size}`;
}
