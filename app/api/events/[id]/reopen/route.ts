// (Events) POST /api/events/:id/reopen: archived → live, while its records still exist. 409 otherwise. Leads only.
import { eventAdmin, type EventRow } from '@/lib/server/events';
import { idParam, json } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute<{ id: string }>('POST /api/events/[id]/reopen', { lead: true, event: 'optional' }, async ({ params }) => {
  const row = await rpc<EventRow>('lp_event_reopen', { p_event: idParam(params) });
  return json({ event: eventAdmin(row) });
});
