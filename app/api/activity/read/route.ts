// POST /api/activity/read {requestId} | {all: true} (F4, spec §18 A56): the request was opened (from
// Activity, a list, a link or a push), or Mark all read. Answers {count, ids}: the rows that turned read,
// which Undo sends back to POST /api/activity/unread.
import type { ActivityReadResponse } from '@/lib/activity';
import { json, readJson } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { activityReadSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute('POST /api/activity/read', {}, async ({ request, session }) => {
  const body = await readJson(request, activityReadSchema);
  const data = await rpc<{ ids?: unknown } | null>('lp_activity_mark_read', {
    p_staff: session.staff,
    p_request: 'requestId' in body ? body.requestId.toLowerCase() : null,
  });
  const ids = Array.isArray(data?.ids) ? data.ids.filter((x): x is string => typeof x === 'string') : [];
  const out: ActivityReadResponse = { count: ids.length, ids };
  return json(out);
});
