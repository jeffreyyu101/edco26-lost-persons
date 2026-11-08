// GET /api/activity (F4, spec §18 A56): the signed-in staff member's Activity, ONE row per request (its
// latest event), newest first: the latest 100 of the last 3 days. Line 1 is the request's full name
// (alertName, 2026-11-07); line 2 the detail (contract B).
import { mapActivityRow, type ActivityListResponse, type ActivityRow } from '@/lib/activity';
import { json } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute('GET /api/activity', {}, async ({ session }) => {
  const data = await rpc<{ serverTime?: unknown; rows?: unknown } | null>('lp_activity_list', { p_staff: session.staff });
  const rows = Array.isArray(data?.rows) ? data.rows.map(mapActivityRow).filter((r): r is ActivityRow => r !== null) : [];
  const out: ActivityListResponse = { serverTime: typeof data?.serverTime === 'string' ? data.serverTime : new Date().toISOString(), rows };
  return json(out);
});
