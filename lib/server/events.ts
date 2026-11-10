// Events (multi-event foundation, phase 1): reading an event's config, the sign-in secrets (the Ground Control lead
// passcode and each event's staff password, bcrypt hashes in the database) and the join links (only the SHA-256 of
// a code is stored). Server only. Never logs a password, a passcode, a hash, a join code or its hash.
import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { EndedEvent, EventAdmin, EventConfig, EventPost, EventStage, EventTeam, SessionInfo } from '../api-types';
import { ApiFailure } from './errors';
import { sessionInfo } from './session';
import type { SessionClaims } from './session-token';
import { rpc } from './supabase';

/** What lp_event_json returns (already camelCase). */
export interface EventRow {
  id: string;
  slug: string;
  name: string;
  startsOn: string;
  endsOn: string;
  timezone: string;
  dayStartHour: number;
  stage: EventStage;
  logoPath: string | null;
  posts: Array<Partial<EventPost>>;
  mainMedical: string;
  teams: Array<Partial<EventTeam>>;
  lastSeen: unknown[];
  hasStaffPassword: boolean;
  joinLinkExpiresAt: string | null;
  caseSeq: number;
  wentLiveAt: string | null;
  endedAt: string | null;
  recordsDeleteAt: string | null;
  recordsDeletedAt: string | null;
  department?: string | null;
  staffing?: unknown[];
  preparedBy?: string | null;
  createdAt: string;
  updatedAt: string;
  requests?: number;
  open?: number;
}

/** The public logo URL of an event (GET /api/events/logo/<slug>; `v` busts caches when the logo changes). */
export function logoUrl(row: Pick<EventRow, 'slug' | 'logoPath' | 'updatedAt'>): string | null {
  if (!row.logoPath) return null;
  return `/api/events/logo/${encodeURIComponent(row.slug)}?v=${encodeURIComponent(row.logoPath.slice(37, 45))}`;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/** The client's event config. */
export function eventConfig(row: EventRow): EventConfig {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    timezone: row.timezone,
    dayStartHour: row.dayStartHour,
    stage: row.stage,
    logoUrl: logoUrl(row),
    posts: (row.posts ?? []).map((p) => ({ id: str(p.id), label: str(p.label), short: str(p.short) || str(p.label) })),
    mainMedical: row.mainMedical,
    teams: (row.teams ?? []).map((t) => ({ id: str(t.id), label: str(t.label), short: str(t.short) || str(t.label), medical: t.medical === true })),
    lastSeen: (row.lastSeen ?? []).filter((v): v is string => typeof v === 'string'),
    wentLiveAt: row.wentLiveAt,
    endedAt: row.endedAt,
    updatedAt: row.updatedAt,
  };
}

/** A lead's view of an event. */
export function eventAdmin(row: EventRow): EventAdmin {
  return {
    ...eventConfig(row),
    hasStaffPassword: row.hasStaffPassword,
    joinLinkExpiresAt: row.joinLinkExpiresAt,
    caseSeq: Number(row.caseSeq),
    recordsDeleteAt: row.recordsDeleteAt,
    recordsDeletedAt: row.recordsDeletedAt,
    department: row.department ?? null,
    staffing: (Array.isArray(row.staffing) ? row.staffing : []).map((r) => {
      const o = (r ?? {}) as { role?: unknown; name?: unknown };
      return { role: str(o.role), name: str(o.name) };
    }),
    preparedBy: row.preparedBy ?? null,
    createdAt: row.createdAt,
    ...(row.requests !== undefined ? { requests: Number(row.requests) } : {}),
    ...(row.open !== undefined ? { open: Number(row.open) } : {}),
  };
}

/** What the Ended screen shows. */
export function endedEvent(row: EventRow): EndedEvent {
  return { name: row.name, logoUrl: logoUrl(row), stage: 'archived' };
}

/** The 410 for an archived event, carrying what the Ended screen needs. */
export function eventEndedFailure(row: EventRow | null): ApiFailure {
  return new ApiFailure('event_ended', undefined, row ? { extra: { event: endedEvent(row) } } : {});
}

export async function loadEvent(eventId: string): Promise<EventRow | null> {
  return (await rpc<EventRow | null>('lp_event_get', { p_event: eventId })) ?? null;
}

export async function loadEventBySlug(slug: string): Promise<EventRow | null> {
  return (await rpc<EventRow | null>('lp_event_by_slug', { p_slug: slug })) ?? null;
}

/** The SessionInfo of a set of claims, with the event config (null when no event is open or it is gone). */
export async function sessionBody(claims: SessionClaims, known?: EventRow | null): Promise<SessionInfo> {
  const row = claims.eventId ? (known && known.id === claims.eventId ? known : await loadEvent(claims.eventId)) : null;
  return sessionInfo(claims, row ? eventConfig(row) : null);
}

/** The event or 404. */
export async function requireEvent(eventId: string): Promise<EventRow> {
  const row = await loadEvent(eventId);
  if (!row) throw new ApiFailure('not_found');
  return row;
}

/** True when `team` is one of the event's sign-in teams (by label, case-insensitive). */
export function isEventTeam(row: Pick<EventRow, 'teams'>, team: string): boolean {
  const t = team.trim().toLowerCase();
  return (row.teams ?? []).some((x) => str(x.label).toLowerCase() === t);
}

/** The label of `team` as the event spells it. */
export function eventTeamLabel(row: Pick<EventRow, 'teams'>, team: string): string {
  const t = team.trim().toLowerCase();
  return str((row.teams ?? []).find((x) => str(x.label).toLowerCase() === t)?.label, team);
}

// ---------------------------------------------------------------------------------------------------
// Passwords: the lead passcode and each event's staff password (bcrypt)
// ---------------------------------------------------------------------------------------------------

/** bcrypt cost for new hashes (≈ 70 ms in bcryptjs). */
export const BCRYPT_COST = 10;

export function hashSecret(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

async function matches(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

interface AuthSecrets {
  lead: string | null;
  /** lp_org.lead_passcode_version: what a lead's token carries (pv). */
  leadVersion?: number;
  events: Array<{ id: string; stage: EventStage; hash: string }>;
}

export type PasswordMatch = { kind: 'lead'; version: number } | { kind: 'event'; eventId: string; stage: EventStage } | null;

/**
 * Sign-in with a password (spec "Server"): the lead passcode first; then each event's staff password, live and
 * practice events before archived ones (an archived event's old password never shadows a running one).
 */
export async function matchPassword(plain: string): Promise<PasswordMatch> {
  const secrets = await rpc<AuthSecrets>('lp_auth_secrets', {});
  if (await matches(plain, secrets?.lead)) return { kind: 'lead', version: Number(secrets?.leadVersion ?? 0) };
  for (const e of secrets?.events ?? []) {
    if (await matches(plain, e.hash)) return { kind: 'event', eventId: e.id, stage: e.stage };
  }
  return null;
}

/**
 * The uniqueness rule (spec "Server"): a staff password may not equal the lead passcode or another non-archived
 * event's staff password. The lead passcode may not equal ANY event's staff password, archived ones included: the
 * lead passcode is checked first at sign-in, so an old event's password would otherwise sign its staff in as lead.
 * Throws 422 invalid (field `password` / `passcode`).
 */
export async function assertSecretUnique(plain: string, target: { kind: 'event'; eventId: string } | { kind: 'lead' }): Promise<void> {
  const secrets = await rpc<AuthSecrets>('lp_auth_secrets', {});
  const field = target.kind === 'lead' ? 'passcode' : 'password';
  const clash = () => new ApiFailure('invalid', 'Choose a different password', { extra: { field } });
  if (target.kind === 'event' && (await matches(plain, secrets?.lead))) throw clash();
  for (const e of secrets?.events ?? []) {
    if (target.kind === 'event' && (e.stage === 'archived' || e.id === target.eventId)) continue;
    if (await matches(plain, e.hash)) throw clash();
  }
}

// ---------------------------------------------------------------------------------------------------
// Join links: https://<host>/signin#join=<slug>.<code> (the code is 32 random bytes, base64url)
// ---------------------------------------------------------------------------------------------------

const NO_DIGEST = Buffer.alloc(32);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A fresh join code (never stored; only its SHA-256 is). */
export function newJoinCode(): string {
  return randomBytes(32).toString('base64url');
}

/** What the link carries after `#join=`: "<slug>.<code>". */
export function joinToken(slug: string, code: string): string {
  return `${slug}.${code}`;
}

/** "<slug>.<code>" → its parts; a token without a known-looking slug (an older link) is all code. */
export function parseJoinToken(raw: string): { slug: string | null; code: string } {
  const value = raw.trim();
  const dot = value.indexOf('.');
  if (dot > 0) {
    const slug = value.slice(0, dot).toLowerCase();
    if (SLUG_RE.test(slug)) return { slug, code: value.slice(dot + 1) };
  }
  return { slug: null, code: value };
}

export interface InviteCandidate {
  id: string;
  stage: EventStage;
  sha256: string;
  expiresAt: string | null;
}

function digestEquals(code: string, hex: string | null | undefined): boolean {
  const digest = createHash('sha256').update(code, 'utf8').digest();
  const stored = typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : NO_DIGEST;
  return timingSafeEqual(digest, stored) && stored !== NO_DIGEST;
}

export type InviteMatch = { eventId: string; stage: EventStage } | null;

/**
 * The event a join link opens: the slug's event (or, for a link without one, any event) whose code matches, in
 * constant time per candidate. A live or practice event's link must not have expired; an archived event's link
 * matches whatever its expiry, so an old link still reaches the Ended screen.
 */
export async function matchInvite(raw: string, nowMs: number = Date.now()): Promise<InviteMatch> {
  const { slug, code } = parseJoinToken(raw);
  let candidates = await rpc<InviteCandidate[]>('lp_invite_candidates', { p_slug: slug });
  // "<x>.<rest>" where x is not one of the slugs: an older link whose code has a dot.
  if (slug && (!Array.isArray(candidates) || candidates.length === 0)) {
    candidates = await rpc<InviteCandidate[]>('lp_invite_candidates', { p_slug: null });
    return pickInvite(candidates, raw.trim(), nowMs);
  }
  return pickInvite(candidates, code, nowMs);
}

/** The matching candidate (exported for the unit tests). */
export function pickInvite(candidates: InviteCandidate[] | null, code: string, nowMs: number): InviteMatch {
  let found: InviteMatch = null;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    // Every candidate is compared (no early exit), so the answer takes the same time whichever one matches.
    const same = digestEquals(code, c.sha256);
    const live = c.stage === 'archived' || (c.expiresAt !== null && nowMs < Date.parse(c.expiresAt));
    if (same && live && !found) found = { eventId: c.id, stage: c.stage };
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------
// Lead routes
// ---------------------------------------------------------------------------------------------------

/** The event settings a lead sends (camelCase) → lp_event_create / lp_event_update's keys. */
export function settingsPayload(input: Record<string, unknown>): Record<string, unknown> {
  const keys: Record<string, string> = {
    slug: 'slug', name: 'name', startsOn: 'starts_on', endsOn: 'ends_on', timezone: 'timezone', dayStartHour: 'day_start_hour',
    posts: 'posts', mainMedical: 'main_medical', teams: 'teams', lastSeen: 'last_seen',
    department: 'department', staffing: 'staffing', preparedBy: 'prepared_by',
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined && keys[k]) out[keys[k]] = v;
  return out;
}

/** Bucket of the event logos (private; GET /api/events/logo/<slug> redirects to a signed URL). */
export const LOGO_BUCKET = 'event-logos';
export const LOGO_MAX_BYTES = 1024 * 1024;
