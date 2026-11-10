// (Events) POST /api/events/:id/end: live → archived: staff are locked out (every write answers 410 event_ended), nothing is deleted; open requests stay as they are. 409 unless live. Leads only.
import { eventAdmin, type EventRow } from '@/lib/server/events';
import { idParam, json } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute<{ id: string }>('POST /api/events/[id]/end', { lead: true, event: 'optional' }, async ({ params }) => {
  const row = await rpc<EventRow>('lp_event_end', { p_event: idParam(params) });
  return json({ event: eventAdmin(row) });
});
