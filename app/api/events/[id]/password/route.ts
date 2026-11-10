// (Events) POST /api/events/:id/password {password}: sets the event's staff password (bcrypt; only the hash is stored).
// Refused (422, field password) when it equals the Ground Control lead passcode or another non-archived event's
// staff password: a password must name exactly one way in. DELETE turns password sign-in off. Leads only.
import { assertSecretUnique, eventAdmin, hashSecret, type EventRow } from '@/lib/server/events';
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
  await assertSecretUnique(password, { kind: 'event', eventId: id });
  const row = await rpc<EventRow>('lp_event_set_password', { p_event: id, p_hash: await hashSecret(password) });
  return json({ event: eventAdmin(row) });
});

export const DELETE = authedRoute<P>('DELETE /api/events/[id]/password', { lead: true, event: 'optional' }, async ({ params }) => {
  const row = await rpc<EventRow>('lp_event_set_password', { p_event: idParam(params), p_hash: null });
  return json({ event: eventAdmin(row) });
});
