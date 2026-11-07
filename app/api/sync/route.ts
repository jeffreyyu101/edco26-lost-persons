// GET /api/sync (spec §6, A7, A37). Delta / full / paged / reconcile, or ?ids= for specific rows (≤ 200).
// Cursors (serverTime, next.at) are returned verbatim from the database clock; no ETag / 304.
// The first page of a poll also carries the signed-in staff member's unread Activity (F4, spec §18 A56,
// additive: activityUnread, activityUnreadIds), read in parallel; when it can't be read the fields are left
// out and the rows still sync.
import type { SyncResponse } from '@/lib/api-types';
import { json, parseQuery } from '@/lib/server/http';
import { mapSync } from '@/lib/server/mappers';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { syncQuerySchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_PAGE = 500;

type ActivityPart = Pick<SyncResponse, 'activityUnread' | 'activityUnreadIds'>;

async function unreadActivity(staff: string): Promise<ActivityPart> {
  try {
    const data = await rpc<{ ids?: unknown } | null>('lp_activity_unread', { p_staff: staff });
    const ids = Array.isArray(data?.ids) ? data.ids.filter((x): x is string => typeof x === 'string') : [];
    // The empty delta stays about 100 bytes (spec §7 Data use): no ids list when nothing is unread.
    return ids.length > 0 ? { activityUnread: ids.length, activityUnreadIds: ids } : { activityUnread: 0 };
  } catch {
    return {};
  }
}

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
  const firstPage = !q.ids && !q.afterAt;
  const [raw, activity] = await Promise.all([rpc<unknown>('lp_sync', args), firstPage ? unreadActivity(session.staff) : Promise.resolve<ActivityPart>({})]);
  return json({ ...mapSync(raw), ...activity });
});
