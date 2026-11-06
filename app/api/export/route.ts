// GET /api/export (spec §6): every request as CSV, times in the event timezone, injection-guarded.
// Rows are read through lp_sync pages (one jsonb value per call, so no PostgREST row cap applies).
import { buildCsv, csvFilename } from '@/lib/server/csv';
import { serverEnv } from '@/lib/server/env';
import { ApiFailure } from '@/lib/server/errors';
import { NO_STORE } from '@/lib/server/http';
import { mapSync } from '@/lib/server/mappers';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import type { RequestSummary } from '@/lib/api-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE = 1000;
const MAX_PAGES = 200;

export const GET = authedRoute('GET /api/export', {}, async () => {
  const timeZone = serverEnv().eventTimezone;
  // Keyed by id: a row updated while paging moves to a later page and is simply read again (latest wins).
  const rows = new Map<string, RequestSummary>();
  let after: { at: string; id: string } | null = null;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) throw new ApiFailure('unavailable', undefined, { dbCode: 'export_pages' });
    const res = mapSync(
      await rpc<unknown>('lp_sync', {
        p_since: null,
        p_ids: null,
        p_reconcile: false,
        p_after_at: after?.at ?? null,
        p_after_id: after?.id ?? null,
        p_limit: PAGE,
      }),
    );
    for (const row of res.rows) rows.set(row.id, row);
    if (!res.hasMore || !res.next) break;
    after = res.next;
  }

  const now = new Date();
  return new Response(buildCsv([...rows.values()], timeZone), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename(now, timeZone)}"`,
      'Cache-Control': NO_STORE,
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
