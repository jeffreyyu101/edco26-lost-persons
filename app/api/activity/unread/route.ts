// GET /api/activity/unread (F4, spec §18 A56): what the bell counts, {count, ids (newest first, ≤ 100), key}.
// The client asks only when the activityKey on sync moved, so a poll never carries the ids.
// POST /api/activity/unread {requestIds}: Undo of Mark all read. Those rows are unread again (a row a newer
// event already made unread stays as it is). Answers {count}.
import type { ActivityUnreadIdsResponse, ActivityUnreadResponse } from '@/lib/activity';
import { json, readJson } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { activityUnreadSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute('GET /api/activity/unread', {}, async ({ session }) => {
  const data = await rpc<{ ids?: unknown; key?: unknown } | null>('lp_activity_unread', { p_staff: session.staff });
  const ids = Array.isArray(data?.ids) ? data.ids.filter((x): x is string => typeof x === 'string') : [];
  const out: ActivityUnreadIdsResponse = { count: ids.length, ids, key: typeof data?.key === 'string' ? data.key : null };
  return json(out);
});

export const POST = authedRoute('POST /api/activity/unread', {}, async ({ request, session }) => {
  const body = await readJson(request, activityUnreadSchema);
  const count = await rpc<unknown>('lp_activity_unmark', { p_staff: session.staff, p_requests: body.requestIds.map((id) => id.toLowerCase()) });
  const out: ActivityUnreadResponse = { count: typeof count === 'number' ? count : 0 };
  return json(out);
});
