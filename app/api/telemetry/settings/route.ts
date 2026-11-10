// POST /api/telemetry/settings {enabled} (design §3): the kill switch on /health. (Events) Leads only, both ways: a
// collection stopped for a privacy or budget reason is turned back on by a lead, never by any staff browser.
//
//   {enabled: false}  records a tel_switch row (team only, written while collection is still on; only when the lead
//                     has an event open: telemetry rows belong to an event), flips lp_tel_settings.enabled off, forgets
//                     this instance's cached config (other instances follow within 30 s) and answers with the config.
//   {enabled: true}   flips it back on (lp_tel_set(true)), forgets the cached config and answers with the config.
//                     Collection then runs again while any event is practice or live.
import { z } from 'zod';
import { json, readJson } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { invalidateTelemetryConfig, parseTelemetryConfig, recordServerEvents, teamKey } from '@/lib/server/telemetry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ enabled: z.boolean() }).strict();

export const POST = authedRoute('POST /api/telemetry/settings', { event: 'optional', lead: true }, async ({ request, session }) => {
  const { enabled } = await readJson(request, bodySchema);
  if (!enabled && session.eventId) await recordServerEvents(session.eventId, [{ n: 'tel_switch', team: teamKey(session.claims.team), ok: false }]);
  const raw = await rpc<unknown>('lp_tel_set', { p_enabled: enabled });
  invalidateTelemetryConfig();
  return json(parseTelemetryConfig(raw));
});
