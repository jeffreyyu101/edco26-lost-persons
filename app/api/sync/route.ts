// GET /api/sync (spec §6, A7, A37). Delta / full / paged / reconcile, or ?ids= for specific rows (≤ 200).
// Cursors (serverTime, next.at) are returned verbatim from the database clock; no ETag / 304.
import { json, parseQuery } from '@/lib/server/http';
import { mapSync } from '@/lib/server/mappers';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { syncQuerySchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_PAGE = 500;

export const GET = authedRoute('GET /api/sync', {}, async ({ request }) => {
  const q = parseQuery(new URL(request.url).searchParams, syncQuerySchema);
  const args = q.ids
    ? { p_since: null, p_ids: q.ids, p_reconcile: false, p_after_at: null, p_after_id: null, p_limit: DEFAULT_PAGE }
    : {
        p_since: q.since ?? null,
        p_ids: null,
        p_reconcile: q.reconcile === '1',
        p_after_at: q.afterAt ?? null,
        p_after_id: q.afterId ?? null,
        p_limit: q.limit ?? DEFAULT_PAGE,
      };
  return json(mapSync(await rpc<unknown>('lp_sync', args)));
});
