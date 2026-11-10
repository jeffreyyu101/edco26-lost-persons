// (Events) POST /api/org/lead-passcode {passcode}: changes the Ground Control lead passcode (one for every event).
// Refused (422, field passcode) when it equals a non-archived event's staff password. Leads only.
import { assertSecretUnique, hashSecret } from '@/lib/server/events';
import { json, readJson } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { leadPasscodeSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute('POST /api/org/lead-passcode', { lead: true, event: 'optional' }, async ({ request }) => {
  const { passcode } = await readJson(request, leadPasscodeSchema);
  await assertSecretUnique(passcode, { kind: 'lead' });
  await rpc('lp_org_set_lead_passcode', { p_hash: await hashSecret(passcode) });
  return json({ ok: true });
});
