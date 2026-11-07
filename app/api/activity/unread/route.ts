// POST /api/activity/unread {requestIds} (F4, spec §18 A56): Undo of Mark all read. Those rows are unread
// again (a row a newer event already made unread stays as it is). Answers {count}.
import type { ActivityUnreadResponse } from '@/lib/activity';
import { json, readJson } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { activityUnreadSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute('POST /api/activity/unread', {}, async ({ request, session }) => {
  const body = await readJson(request, activityUnreadSchema);
  const count = await rpc<unknown>('lp_activity_unmark', { p_staff: session.staff, p_requests: body.requestIds.map((id) => id.toLowerCase()) });
  const out: ActivityUnreadResponse = { count: typeof count === 'number' ? count : 0 };
  return json(out);
});
