// POST /api/push/prefs (F4, spec §18 A55): the Alerts switches of the signed-in staff member, and whether
// Web Push works here at all ({enabled, publicKey}). With no switch in the body it only reads them (they are
// created with the defaults on first use: New requests as this phone's old "Alerts" bell was, off unless it
// was on; Updates on my requests on). A switch in the body changes it for every device of theirs.
// A POST (not a GET) because the first call creates the row: it goes through the same-origin check.
import type { PushConfigResponse } from '@/lib/activity';
import { json, readJson } from '@/lib/server/http';
import { vapidConfig } from '@/lib/server/push';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { pushPrefsSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute('POST /api/push/prefs', {}, async ({ request, session }) => {
  const body = await readJson(request, pushPrefsSchema);
  const prefs = await rpc<{ newRequests?: unknown; myUpdates?: unknown } | null>('lp_push_prefs_sync', {
    p_staff: session.staff,
    p_team: session.claims.team,
    p_new_requests: body.newRequests ?? null,
    p_my_updates: body.myUpdates ?? null,
    p_default_new_requests: body.bell === true ? true : null,
  });
  const vapid = vapidConfig();
  const out: PushConfigResponse = {
    enabled: vapid !== null,
    publicKey: vapid?.publicKey ?? null,
    newRequests: prefs?.newRequests === true,
    myUpdates: prefs?.myUpdates !== false,
  };
  return json(out);
});
