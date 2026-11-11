// POST /api/push/test {endpoint}: "Send a test alert" in the Alerts sheet (F4, spec §18 A55). A real push
// to THIS device only, and only when the device's subscription belongs to the signed-in staff member (else
// 404). {sent} says whether the push service took it; a subscription the service says is gone is deleted.
import { testPayload, type PushTestResponse } from '@/lib/activity';
import { ApiFailure } from '@/lib/server/errors';
import { json, readJson } from '@/lib/server/http';
import { groupOutcomes, pushEnabled, sendPushes, type PushTarget } from '@/lib/server/push';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { pushEndpointSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute('POST /api/push/test', { event: 'optional' }, async ({ request, session }) => {
  const body = await readJson(request, pushEndpointSchema);
  if (!pushEnabled()) throw new ApiFailure('not_found');
  const target = await rpc<PushTarget | null>('lp_push_test_target', { p_endpoint: body.endpoint, p_staff: session.staff });
  if (!target || typeof target.endpoint !== 'string') throw new ApiFailure('not_found');
  const outcomes = await sendPushes([target], () => testPayload(), { ttl: 60, urgency: 'high' });
  const grouped = groupOutcomes(outcomes);
  await rpc('lp_push_result', { p_ok: grouped.ok, p_gone: grouped.gone, p_failed: grouped.failed }).catch(() => undefined);
  const out: PushTestResponse = { sent: grouped.ok.length === 1 };
  return json(out);
});
