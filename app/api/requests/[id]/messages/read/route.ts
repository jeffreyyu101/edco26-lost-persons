// POST /api/requests/:id/messages/read (lp_mark_read): the caller saw the thread up to `upto` (the newest
// message on screen). Moves the read cursor forward only; never audited. Returns the caller's activity.
import type { ActivityResponse } from '@/lib/api-types';
import { idParam, json, readJson } from '@/lib/server/http';
import { mapActivity } from '@/lib/server/messages';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { markReadSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute<{ id: string }>('POST /api/requests/[id]/messages/read', {}, async ({ request, params, session, eventId }) => {
  const id = idParam(params);
  const body = await readJson(request, markReadSchema);
  const data = await rpc<{ changed?: unknown; activity?: unknown }>('lp_mark_read', {
    p_event: eventId,
    p_request: id,
    p_staff: session.staff,
    p_upto: body.upto ?? null,
  });
  const out: ActivityResponse = { changed: data.changed === true, activity: mapActivity(data.activity) };
  return json(out);
});
