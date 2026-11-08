// POST /api/telemetry/settings {enabled} (design §3): the kill switch on /health. It only ever turns collection OFF:
// any signed-in session may stop it (the same trust as reading /health: the data holds no personal details), but a
// collection someone stopped for a privacy or budget reason is never restarted from a browser.
//
//   {enabled: false}  records a tel_switch row (team only, written while collection is still on), flips
//                     lp_tel_settings.enabled off, forgets this instance's cached config (other instances follow within
//                     30 s) and answers with the config.
//   {enabled: true}   writes nothing. Turning collection back on is SQL only (HANDOFF.md "Telemetry in production":
//                     lp_tel_set(true)). It re-reads the settings for this instance and answers with the config when
//                     they are on, 403 when they are off.
import { z } from 'zod';
import { ApiFailure } from '@/lib/server/errors';
import { json, readJson } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { invalidateTelemetryConfig, parseTelemetryConfig, recordServerEvents, teamKey, telemetryConfig } from '@/lib/server/telemetry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ enabled: z.boolean() }).strict();

export const POST = authedRoute('POST /api/telemetry/settings', {}, async ({ request, session }) => {
  const { enabled } = await readJson(request, bodySchema);
  if (enabled) {
    invalidateTelemetryConfig();
    const cfg = await telemetryConfig();
    if (!cfg.enabled) throw new ApiFailure('forbidden', 'Collection is turned back on in SQL only');
    return json(cfg);
  }
  await recordServerEvents([{ n: 'tel_switch', team: teamKey(session.claims.team), ok: false }]);
  const raw = await rpc<unknown>('lp_tel_set', { p_enabled: false });
  invalidateTelemetryConfig();
  return json(parseTelemetryConfig(raw));
});
