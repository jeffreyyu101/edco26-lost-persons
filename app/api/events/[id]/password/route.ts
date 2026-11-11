// (Events) POST /api/events/:id/password {password}: sets the event's staff password (bcrypt; only the hash is stored).
// Refused (422, field password) when it equals the Ground Control lead passcode or the staff password of another
// event that is running or still holds it (24 h after its End): a password must name exactly one way in. An archived
// event takes none (409; Reopen first). DELETE turns password sign-in off; for an archived event inside its 24 h hold
// it retires the held hash, as the clearing after 24 h does, so the lead passcode can never equal it. Leads only.
import { eventAdmin, setStaffPassword, type EventRow } from '@/lib/server/events';
import { idParam, json, readJson } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { eventPasswordSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = { id: string };

export const POST = authedRoute<P>('POST /api/events/[id]/password', { lead: true, event: 'optional' }, async ({ request, params }) => {
  const id = idParam(params);
  const { password } = await readJson(request, eventPasswordSchema);
  return json({ event: eventAdmin(await setStaffPassword(id, password)) });
});

export const DELETE = authedRoute<P>('DELETE /api/events/[id]/password', { lead: true, event: 'optional' }, async ({ params }) => {
  const row = await rpc<EventRow>('lp_event_set_password', { p_event: idParam(params), p_hash: null });
  return json({ event: eventAdmin(row) });
});
