// POST /api/telemetry/settings {enabled} (design §3): the kill switch on /health. Any signed-in session may use it
// (the same trust as reading /health: the data holds no personal details). It flips lp_tel_settings.enabled, forgets
// this instance's cached config (other instances follow within 30 s), records a tel_switch row (team only) and answers
// with the config. The SQL path (HANDOFF.md "Telemetry in production") stays authoritative.
import { z } from 'zod';
import { json, readJson } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { invalidateTelemetryConfig, parseTelemetryConfig, recordServerEvents, teamKey } from '@/lib/server/telemetry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ enabled: z.boolean() }).strict();

export const POST = authedRoute('POST /api/telemetry/settings', {}, async ({ request, session }) => {
  const { enabled } = await readJson(request, bodySchema);
  const raw = await rpc<unknown>('lp_tel_set', { p_enabled: enabled });
  invalidateTelemetryConfig();
  await recordServerEvents([{ n: 'tel_switch', team: teamKey(session.claims.team), ok: enabled }]);
  return json(parseTelemetryConfig(raw));
});
