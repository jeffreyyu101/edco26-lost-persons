// POST /api/push/subscribe: store (or re-bind) this device's Web Push subscription for the signed-in staff
// member. DELETE /api/push/subscribe: this device stops getting pushes (sign-out). F4, spec §18 A54.
// Same conventions as every route: session, same-origin, zod, ≤ 64 KB JSON, no-store.
//   * Push off on the server (no VAPID keys): POST stores nothing and answers {enabled: false}.
//   * An endpoint that is not a known push service: 422 (the server never posts to an address a client
//     made up).
//   * oldEndpoint: the browser rotated the subscription (pushsubscriptionchange); that row goes when it is the
//     signed-in staff member's.
//   * DELETE removes the subscription only when it is the signed-in staff member's (nobody can switch off
//     another person's device), and never re-issues the session cookie (it runs right before sign-out).
import type { PushConfigResponse } from '@/lib/activity';
import { ApiFailure } from '@/lib/server/errors';
import { json, readJson } from '@/lib/server/http';
import { isAllowedEndpoint, vapidConfig } from '@/lib/server/push';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { pushEndpointSchema, pushSubscribeSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute('POST /api/push/subscribe', {}, async ({ request, session, eventId }) => {
  const body = await readJson(request, pushSubscribeSchema);
  const vapid = vapidConfig();
  if (!vapid) {
    const off: PushConfigResponse = { enabled: false, publicKey: null, newRequests: false, myUpdates: true };
    return json(off);
  }
  if (!isAllowedEndpoint(body.endpoint)) throw new ApiFailure('invalid', 'Unknown push service', { extra: { field: 'endpoint' } });
  const prefs = await rpc<{ newRequests?: unknown; myUpdates?: unknown } | null>('lp_push_subscribe', {
    p_event: eventId,
    p_endpoint: body.endpoint,
    p_p256dh: body.keys.p256dh,
    p_auth: body.keys.auth,
    p_staff: session.staff,
    p_team: session.claims.team,
    p_user_agent: (request.headers.get('user-agent') ?? '').slice(0, 300) || null,
    p_old_endpoint: body.oldEndpoint ?? null,
    p_default_new_requests: body.bell === true ? true : null,
  });
  const out: PushConfigResponse = {
    enabled: true,
    publicKey: vapid.publicKey,
    newRequests: prefs?.newRequests === true,
    myUpdates: prefs?.myUpdates !== false,
  };
  return json(out);
});

export const DELETE = authedRoute('DELETE /api/push/subscribe', { refresh: false, event: 'optional', afterEnd: true }, async ({ request, session }) => {
  const body = await readJson(request, pushEndpointSchema);
  const removed = await rpc<unknown>('lp_push_unsubscribe', { p_endpoint: body.endpoint, p_staff: session.staff });
  return json({ removed: removed === true });
});
