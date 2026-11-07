// GET /api/sync (spec §6, A7, A37). Delta / full / paged / reconcile, or ?ids= for specific rows (≤ 200).
// Cursors (serverTime, next.at) are returned verbatim from the database clock; no ETag / 304.
// F3 (spec §18 A55): every row carries the caller's message / en route activity, and the first page of a
// delta adds the rows whose thread changed since the cursor without their patients row changing
// (lib/server/messages.ts decorateSync; a failure there leaves the rows as lp_sync returned them).
import { json, parseQuery } from '@/lib/server/http';
import { mapSync } from '@/lib/server/mappers';
import { decorateSync } from '@/lib/server/messages';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { syncQuerySchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_PAGE = 500;

export const GET = authedRoute('GET /api/sync', {}, async ({ request, session }) => {
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
  const sync = mapSync(await rpc<unknown>('lp_sync', args));
  const firstDeltaPage = !q.ids && !!q.since && !q.afterAt;
  return json(await decorateSync(sync, { staff: session.staff, since: q.since ?? null, changed: firstDeltaPage }));
});
