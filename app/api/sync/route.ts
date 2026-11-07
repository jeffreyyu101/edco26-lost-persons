// GET /api/sync (spec §6, A7, A37). Delta / full / paged / reconcile, or ?ids= for specific rows (≤ 200).
// Cursors (serverTime, next.at) are returned verbatim from the database clock; no ETag / 304.
// F3 (spec §21 A76): every row carries the caller's message / en route activity, and the first page of a
// delta adds the rows whose thread changed since the cursor without their patients row changing
// (lib/server/messages.ts decorateSync; a failure there leaves the rows as lp_sync returned them).
// The first page of a poll also carries the signed-in staff member's unread Activity (F4, spec §22 A85,
// additive: activityUnread and the fingerprint activityKey, about 50 bytes; the ids are fetched only when the
// key moves), read in parallel; when it can't be read the fields are left out and the rows still sync.
// F6 (spec §24 A100): when the answer holds a request the server closed for inactivity in the last 15 minutes, the
// handler claims and tells that close after the response (lib/server/inactive-notify.ts), once across all phones.
import { after } from 'next/server';
import type { SyncResponse } from '@/lib/api-types';
import { json, parseQuery } from '@/lib/server/http';
import { inactiveCandidates, notifyInactiveCloses } from '@/lib/server/inactive-notify';
import { mapSync } from '@/lib/server/mappers';
import { decorateSync } from '@/lib/server/messages';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { syncQuerySchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_PAGE = 500;

type ActivityPart = Pick<SyncResponse, 'activityUnread' | 'activityKey'>;

async function unreadActivity(staff: string): Promise<ActivityPart> {
  try {
    const data = await rpc<{ count?: unknown; key?: unknown } | null>('lp_activity_unread', { p_staff: staff });
    if (typeof data?.count !== 'number') return {};
    // The poll stays small (spec §7 Data use): the count and the key, never the ids; with nothing unread the
    // count alone (the empty delta stays about 100 bytes; a 0 says everything is read).
    return { activityUnread: data.count, ...(data.count > 0 && typeof data.key === 'string' ? { activityKey: data.key } : {}) };
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
  const sync = mapSync(raw);
  const firstDeltaPage = !q.ids && !!q.since && !q.afterAt;
  const out = { ...(await decorateSync(sync, { staff: session.staff, since: q.since ?? null, changed: firstDeltaPage })), ...activity };
  const closed = inactiveCandidates(out.rows);
  if (closed.length > 0) after(() => notifyInactiveCloses(closed));
  return json(out);
});
