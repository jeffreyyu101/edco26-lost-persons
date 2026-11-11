// (Events) GET /api/events/:id (a lead's view of one event) and PATCH /api/events/:id (its settings: name, link name,
// dates, time zone, show-day start, posts, Main Med's name, teams, "Last seen" chips). Leads only.
import { ApiFailure } from '@/lib/server/errors';
import { eventAdmin, requireEvent, settingsPayload, type EventRow } from '@/lib/server/events';
import { idParam, json, readJson } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { eventPatchSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = { id: string };

export const GET = authedRoute<P>('GET /api/events/[id]', { lead: true, event: 'optional' }, async ({ params }) => {
  return json({ event: eventAdmin(await requireEvent(idParam(params))) });
});

export const PATCH = authedRoute<P>('PATCH /api/events/[id]', { lead: true, event: 'optional' }, async ({ request, params }) => {
  const id = idParam(params);
  const input = await readJson(request, eventPatchSchema);
  const row = await rpc<EventRow | null>('lp_event_update', { p_event: id, p: settingsPayload(input) });
  if (!row) throw new ApiFailure('not_found');
  return json({ event: eventAdmin(row) });
});
