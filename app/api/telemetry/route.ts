// POST /api/telemetry (design/references/observability-design.md §3): one batch of telemetry from a phone's collector
// (lib/client/telemetry). Cheap checks first: origin, session, the cached config, then the body, then ONE RPC that
// dedupes the batch, enforces the per-hour caps (per device id, per sign-in from the session, and fleet-wide; bytes
// counted after gzip is inflated) and writes the rows.
//
//   200 {on: true, until, flushSeconds, sample, now, rejected, capped?}
//   204 collection is off (the kill switch, past off_at, no settings table): nothing is read or written, and the
//       phone stops and checks back every 30 minutes
//   503 the settings couldn't be read just now: the phone keeps its batches and backs off
//   401 / 403 / 413 / 415 / 422 / 503 through the wrapper (the log line has the route, status and timing only)
//
// `refresh: false`: a telemetry answer never re-issues the session cookie (a late one must not bring back a cookie the
// user just signed out of). The team comes from the session, never from the body. The origin check is the route's own
// (assertTelemetryOrigin): a hidden page's sendBeacon from an iPhone carries `Origin: null` and is accepted only with
// `Sec-Fetch-Site: same-origin`.
import { json } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import {
  assertTelemetryOrigin,
  clampSkew,
  invalidateTelemetryConfig,
  parseBatch,
  quotaKey,
  readTelemetryBody,
  teamKey,
  telemetryConfig,
  type IngestResult,
} from '@/lib/server/telemetry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const off = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

export const POST = authedRoute('POST /api/telemetry', { refresh: false, sameOrigin: false }, async ({ request, session }) => {
  assertTelemetryOrigin(request);
  const cfg = await telemetryConfig();
  if (!cfg.on) return off();
  const { bytes, text } = await readTelemetryBody(request);
  const batch = parseBatch(text);
  const answer = (extra: Record<string, unknown> = {}) =>
    json({ on: true, until: cfg.until, flushSeconds: cfg.flushSeconds, sample: cfg.sample, now: Date.now(), rejected: batch.rejected, ...extra });
  // The probe after an "off": nothing to write, only whether collection is back on.
  if (batch.ev.length === 0) return answer();
  const res = await rpc<IngestResult | null>('lp_tel_ingest', {
    p_batch: batch.b,
    p_device: batch.d,
    p_session: batch.s,
    p_team: teamKey(session.claims.team),
    p_skew_ms: clampSkew(Date.now() - batch.sent),
    p_ctx: batch.ctx,
    p_events: batch.ev,
    p_bytes: bytes,
    p_quota: quotaKey(session.claims.sid),
  });
  if (!res || res.on === false) {
    invalidateTelemetryConfig();
    return off();
  }
  return answer(res.capped ? { capped: true } : {});
});
