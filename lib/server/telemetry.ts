// Telemetry on the server (design/references/observability-design.md §3): the ingest route's config cache, body
// reader and validation, the team key, and the rows the server writes itself (push_send, tel_switch). Server only.
//
//   * Fails closed only when it is sure: a missing settings table or function is "off" (204, every phone stops). A
//     transient failure (a 503, a timeout) is 503 for a few seconds, so phones keep their batches and back off.
//   * The team comes from the session (lib/telemetry.ts teamKey), never from the body.
//   * Never logs a body or an event; never throws from the server-event helpers.
import 'server-only';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import {
  CRUMB_RE,
  DIGIT_RUN_RE,
  ENGINES,
  ENUM_RE,
  EFFECTIVE,
  EVENT_NAMES,
  FRUSTRATION,
  LAYOUTS,
  PLATFORMS,
  PROP_KEYS,
  SERVER_ONLY_EVENTS,
  TEL_GZIP_TYPE,
  TEL_LIMITS,
  TOKEN_RE,
  VIEWS,
  teamKey,
  type EventName,
  type TeamKey,
} from '../telemetry';
import { parseStaff } from '../domain';
import { loadEvent } from './events';
import { ApiFailure } from './errors';
import { assertSameOrigin, readBodyLimited } from './http';
import { rpc } from './supabase';

export { teamKey };

// ---------------------------------------------------------------------------------------------------
// Config (cached 30 s per server instance)
// ---------------------------------------------------------------------------------------------------

export interface TelemetryConfig {
  /** Collecting now: enabled and (Events) some event is practice or live (lp_tel_config decides). */
  on: boolean;
  /** The kill switch (lp_tel_settings.enabled). */
  enabled: boolean;
  /** Epoch ms of lp_tel_settings.off_at: (Events) informational only, it no longer switches collection off. */
  until: number;
  cap: number;
  capBytes: number;
  flushSeconds: number;
  sample: number;
}

export const TELEMETRY_CONFIG_TTL_MS = 30_000;
export const TELEMETRY_OFF: TelemetryConfig = Object.freeze({ on: false, enabled: false, until: 0, cap: 0, capBytes: 0, flushSeconds: 60, sample: 1 });

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);

/** lp_tel_config()'s answer, read defensively (anything unexpected is off). */
export function parseTelemetryConfig(raw: unknown): TelemetryConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const until = num(r.until, 0);
  return {
    on: r.on === true,
    enabled: r.enabled === true,
    until,
    cap: num(r.cap, 0),
    capBytes: num(r.capBytes, 0),
    flushSeconds: Math.min(3600, Math.max(30, Math.round(num(r.flushSeconds, 60)))),
    sample: Math.min(1, Math.max(0, num(r.sample, 1))),
  };
}

/** A failed read that isn't a definite "off" (a 503, a fetch error, the timeout) is cached this long only. */
export const TELEMETRY_CONFIG_RETRY_MS = 5_000;
/** The settings can't exist (the migration was never applied): off, cached like an answer. */
const DEFINITELY_OFF: ReadonlySet<string> = new Set(['PGRST202', '42883', '42P01']);

let cached: { at: number; ttl: number; value: Promise<TelemetryConfig> } | null = null;

/**
 * lp_tel_config(), cached TELEMETRY_CONFIG_TTL_MS per instance. A missing function or table is off (cached too, so it
 * costs one call per 30 s). Any other failure rejects with 503 unavailable for TELEMETRY_CONFIG_RETRY_MS: the phone
 * keeps its batches and backs off, where a 204 would wipe them and stop it for 30 minutes.
 */
export function telemetryConfig(now = Date.now()): Promise<TelemetryConfig> {
  if (cached && now - cached.at < cached.ttl) {
    return cached.value;
  }
  const entry: { at: number; ttl: number; value: Promise<TelemetryConfig> } = { at: now, ttl: TELEMETRY_CONFIG_TTL_MS, value: Promise.resolve(TELEMETRY_OFF) };
  entry.value = rpc<unknown>('lp_tel_config', {}).then(parseTelemetryConfig, (error: unknown) => {
    const code = error instanceof ApiFailure ? error.dbCode : undefined;
    if (code && DEFINITELY_OFF.has(code)) return TELEMETRY_OFF;
    entry.ttl = TELEMETRY_CONFIG_RETRY_MS;
    throw new ApiFailure('unavailable', undefined, { dbCode: code ?? 'tel_config' });
  });
  // Nobody may be waiting on the cached copy when it fails: never an unhandled rejection.
  entry.value.catch(() => undefined);
  cached = entry;
  return entry.value;
}

/** The kill switch moved, or the ingest RPC said off: read the settings again next time. */
export function invalidateTelemetryConfig(): void {
  cached = null;
}

/** Tests: forget the cached config. */
export const resetTelemetryConfigCache = invalidateTelemetryConfig;

/**
 * The per-hour quota key the server derives from the session (never from the body): a hash of the sign-in's sid, so a
 * session that sends a new device id with every batch still meets one cap. Only this hash is stored (lp_tel_quota,
 * deleted after 2 days).
 */
export function quotaKey(sid: string): string {
  return `s${createHash('sha256').update(`lp-tel-quota|${sid}`).digest('hex').slice(0, 20)}`;
}

// ---------------------------------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------------------------------

/**
 * The ingest route's same-origin check. A page's own fetch sends its Origin, which must match (lib/server/http.ts
 * assertSameOrigin). A hidden page's sendBeacon is a no-cors POST, and under the app's `Referrer-Policy: no-referrer`
 * WebKit (every iPhone) sends `Origin: null` for it: then `Sec-Fetch-Site: same-origin`, a header no script can set,
 * must say it came from this site. Anything else is 403 bad_origin.
 */
export function assertTelemetryOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin && origin !== 'null') {
    assertSameOrigin(request);
    return;
  }
  if ((request.headers.get('sec-fetch-site') ?? '').trim().toLowerCase() !== 'same-origin') throw new ApiFailure('bad_origin');
}

// ---------------------------------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------------------------------

export interface TelemetryBody {
  /** Bytes of JSON after any gzip is inflated: what gets stored, and what the per-hour byte caps count. */
  bytes: number;
  text: string;
}

/**
 * The request body: ≤ 48 KB on the wire (413), gzip inflated to at most 256 KB (413: a gzip bomb stops there),
 * application/x-lp-tel+gzip, application/json or text/plain (sendBeacon with a string); anything else 415.
 */
export async function readTelemetryBody(request: Request): Promise<TelemetryBody> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const gzip = type === TEL_GZIP_TYPE;
  if (!gzip && type !== 'application/json' && type !== 'text/plain') throw new ApiFailure('unsupported_media');
  const raw = await readBodyLimited(request, TEL_LIMITS.batchBytes);
  let buf: Uint8Array = raw;
  if (gzip) {
    try {
      buf = gunzipSync(raw, { maxOutputLength: TEL_LIMITS.inflatedBytes });
    } catch (error) {
      if (error instanceof RangeError || (error as { code?: unknown })?.code === 'ERR_BUFFER_TOO_LARGE') throw new ApiFailure('too_large');
      throw new ApiFailure('bad_request', 'Body must be gzip');
    }
  }
  if (buf.byteLength > TEL_LIMITS.inflatedBytes) throw new ApiFailure('too_large');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new ApiFailure('bad_request', 'Body must be UTF-8');
  }
  return { bytes: buf.byteLength, text };
}

// ---------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------

const CLIENT_EVENTS = EVENT_NAMES.filter((n) => !SERVER_ONLY_EVENTS.includes(n)) as [EventName, ...EventName[]];
const FRUSTRATION_SET: ReadonlySet<string> = new Set(FRUSTRATION);
const PROP_SET: ReadonlySet<string> = new Set(PROP_KEYS);
const INT_MAX = 2_147_483_647;
const DAY_MS = 86_400_000;
/** The SQL CHECK caps props and trail at 4096 bytes of jsonb text, which adds spaces: stay well under. */
const JSON_FIELD_MAX = 3_600;

/** No 4-digit run in any stored string (lib/telemetry.ts DIGIT_RUN_RE): the backstop behind the client's tok(). */
const noDigitRun = (s: string): boolean => !DIGIT_RUN_RE.test(s);
const token = z.string().regex(TOKEN_RE).refine(noDigitRun);

/** Rough jsonb::text length: JSON plus the space jsonb prints after each ',' and ':'. */
export function jsonbTextLength(value: unknown): number {
  const s = JSON.stringify(value);
  let extra = 0;
  for (let i = 0; i < s.length; i += 1) if (s[i] === ',' || s[i] === ':') extra += 1;
  return s.length + extra;
}

/** `p`: only PROP_KEYS, ≤ 24 keys; values an int, a bool or an enum token (no 4-digit run); `d` alone an int[] of up to 120 durations. */
export function validProps(value: unknown): value is Record<string, number | boolean | string | number[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > TEL_LIMITS.props) return false;
  for (const [key, v] of entries) {
    if (!PROP_SET.has(key)) return false;
    if (key === 'd') {
      if (!Array.isArray(v) || v.length > TEL_LIMITS.durations) return false;
      if (!v.every((x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= DAY_MS)) return false;
      continue;
    }
    if (typeof v === 'boolean') continue;
    if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= INT_MAX) continue;
    if (typeof v === 'string' && ENUM_RE.test(v) && noDigitRun(v)) continue;
    return false;
  }
  return jsonbTextLength(value) <= JSON_FIELD_MAX;
}

const eventSchema = z
  .object({
    n: z.enum(CLIENT_EVENTS),
    at: z.number().int(),
    v: z.enum(VIEWS).optional(),
    a: token.optional(),
    c: token.optional(),
    ms: z.number().int().min(0).max(DAY_MS).optional(),
    k: z.number().int().min(0).max(100_000).optional(),
    ok: z.boolean().optional(),
    p: z.custom<Record<string, number | boolean | string | number[]>>(validProps).optional(),
    tr: z
      .array(z.tuple([z.number().int().min(-DAY_MS).max(0), z.string().regex(CRUMB_RE).refine(noDigitRun)]))
      .max(TEL_LIMITS.trail)
      .optional(),
  })
  .strict()
  .refine((e) => e.tr === undefined || (FRUSTRATION_SET.has(e.n) && jsonbTextLength(e.tr) <= JSON_FIELD_MAX), { message: 'trail' });

export type TelEventIn = z.output<typeof eventSchema>;

const ctxSchema = z.object({
  plat: z.enum(PLATFORMS),
  osv: z.number().int().min(0).max(99),
  eng: z.enum(ENGINES),
  sa: z.boolean(),
  lay: z.enum(LAYOUTS),
  dpr: z.number().int().min(1).max(3),
  touch: z.boolean(),
  build: z.string().regex(/^[a-z0-9]{1,24}$/),
  eff: z.enum(EFFECTIVE),
  mem: z.number().int().min(-1).max(64),
});
export type TelCtx = z.output<typeof ctxSchema>;

const envelopeSchema = z
  .object({
    v: z.literal(1),
    b: z.string().regex(/^[a-z0-9]{8,24}$/),
    d: z.string().regex(/^[a-z0-9]{8,24}$/),
    s: z.string().regex(/^[a-z0-9]{6,24}$/),
    sent: z.number().int().positive(),
    probe: z.literal(1).optional(),
    ctx: ctxSchema,
    ev: z.array(z.unknown()).max(TEL_LIMITS.batchEvents),
  })
  .refine((b) => b.ev.length > 0 || b.probe === 1, { message: 'ev' });

export interface ParsedBatch {
  b: string;
  d: string;
  s: string;
  sent: number;
  probe: boolean;
  ctx: TelCtx;
  ev: TelEventIn[];
  /** Events dropped by validation (one bad event never loses the batch). */
  rejected: number;
}

/** The envelope (400 for bad JSON, 422 for a bad envelope); each event checked on its own (bad ones dropped, counted). */
export function parseBatch(text: string): ParsedBatch {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiFailure('bad_request', 'Body must be JSON');
  }
  const env = envelopeSchema.safeParse(raw);
  if (!env.success) throw new ApiFailure('invalid', 'Bad telemetry batch');
  const { b, d, s, sent, probe, ctx } = env.data;
  const ev: TelEventIn[] = [];
  let rejected = 0;
  for (const item of env.data.ev) {
    const parsed = eventSchema.safeParse(item);
    if (parsed.success && parsed.data.at >= sent - DAY_MS && parsed.data.at <= sent + 60_000) ev.push(parsed.data);
    else rejected += 1;
  }
  return { b, d, s, sent, probe: probe === 1, ctx, ev, rejected };
}

/** The phone's clock error (server − phone, ms): 0 under 1.5 s; clamped to ±24 h. */
export function clampSkew(ms: number): number {
  if (!Number.isFinite(ms) || Math.abs(ms) < 1_500) return 0;
  return Math.max(-DAY_MS, Math.min(DAY_MS, Math.round(ms)));
}

export interface IngestResult {
  on: boolean;
  accepted?: number;
  dropped?: number;
  dup?: boolean;
  capped?: boolean;
}

// ---------------------------------------------------------------------------------------------------
// Server-side rows
// ---------------------------------------------------------------------------------------------------

export interface ServerRow {
  n: 'push_send' | 'tel_switch';
  team: TeamKey;
  ms?: number;
  k?: number;
  ok?: boolean;
  p?: Record<string, number | boolean | string>;
}

/** Writes server rows when collection is on. Never throws, never logs data. */
export async function recordServerEvents(eventId: string, rows: readonly ServerRow[]): Promise<void> {
  try {
    if (rows.length === 0) return;
    const cfg = await telemetryConfig();
    if (!cfg.on) return;
    await rpc('lp_tel_server_events', { p_event: eventId, p_rows: rows.slice(0, 20) });
  } catch {
    // telemetry never costs the caller anything
  }
}

/**
 * After a Web Push round (lib/server/notify.ts deliver): one push_send row per team of the devices pushed to, with the
 * ok / gone / failed counts and the round's duration. The team comes from each target's attribution; nothing else of it
 * is kept.
 */
export async function recordPushSend(
  eventId: string,
  kind: string,
  targets: ReadonlyArray<{ endpoint: string; staff: string }>,
  outcomes: ReadonlyArray<{ endpoint: string; result: 'ok' | 'gone' | 'failed' }>,
  sendMs: number,
): Promise<void> {
  try {
    const kindToken = ENUM_RE.test(kind) ? kind : 'other';
    // Off: nothing to write (and no event to read).
    if (!(await telemetryConfig()).on) return;
    // (Events) Team keys are the event's team ids.
    const teams = (await loadEvent(eventId).catch(() => null))?.teams ?? [];
    const teamByEndpoint = new Map(targets.map((t) => [t.endpoint, teamKey(parseStaff(t.staff).team, teams)]));
    const byTeam = new Map<TeamKey, { ok: number; gone: number; failed: number }>();
    for (const o of outcomes) {
      const team = teamByEndpoint.get(o.endpoint) ?? 'other';
      const row = byTeam.get(team) ?? { ok: 0, gone: 0, failed: 0 };
      row[o.result] += 1;
      byTeam.set(team, row);
    }
    const ms = Math.max(0, Math.min(DAY_MS, Math.round(sendMs)));
    const rows: ServerRow[] = [...byTeam].map(([team, c]) => ({ n: 'push_send', team, ms, k: c.ok + c.gone + c.failed, p: { kind: kindToken, ...c } }));
    await recordServerEvents(eventId, rows);
  } catch {
    // never throws
  }
}
