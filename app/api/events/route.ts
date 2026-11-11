// (Events) GET /api/events: every event, for a lead (live, practice, then archived; with request counts).
// POST /api/events: a lead creates an event (stage practice). Leads only; same-origin for the POST.
import { eventAdmin, settingsPayload, type EventRow } from '@/lib/server/events';
import { json, readJson } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { eventCreateSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute('GET /api/events', { lead: true, event: 'optional' }, async () => {
  const rows = await rpc<EventRow[] | null>('lp_events_list', {});
  return json({ events: (rows ?? []).map(eventAdmin) });
});

export const POST = authedRoute('POST /api/events', { lead: true, event: 'optional' }, async ({ request }) => {
  const input = await readJson(request, eventCreateSchema);
  const row = await rpc<EventRow>('lp_event_create', { p: settingsPayload(input) });
  return json({ event: eventAdmin(row) }, 201);
});
