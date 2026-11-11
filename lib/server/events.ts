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
import { db, rpc } from './supabase';

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
  /** (Grace period) Until when a Reopen keeps the staff password and join link; null outside it. */
  holdUntil?: string | null;
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
    teams: (row.teams ?? []).map((t) => {
      const aliases = Array.isArray(t.aliases) ? t.aliases.filter((a): a is string => typeof a === 'string') : [];
      return { id: str(t.id), label: str(t.label), short: str(t.short) || str(t.label), medical: t.medical === true, ...(aliases.length ? { aliases } : {}) };
    }),
    lastSeen: (row.lastSeen ?? []).filter((v): v is string => typeof v === 'string'),
    wentLiveAt: row.wentLiveAt,
    endedAt: row.endedAt,
    updatedAt: row.updatedAt,
  };
}

/** The event's posts as label + short (the mappers' postShort), [] without an event. */
export function postNames(row: Pick<EventRow, 'posts'> | null | undefined): Array<{ label: string; short: string }> {
  return (row?.posts ?? []).map((p) => ({ label: str(p.label), short: str(p.short) || str(p.label) })).filter((p) => p.label);
}

/** The event's teams as label + short (display names), [] without an event. */
export function teamNames(row: Pick<EventRow, 'teams'> | null | undefined): Array<{ label: string; short: string }> {
  return (row?.teams ?? []).map((t) => ({ label: str(t.label), short: str(t.short) || str(t.label) })).filter((t) => t.label);
}

/** What a swap place 'mm' is called at the event (its main medical), '' without an event. */
export function mainMedicalOf(row: Pick<EventRow, 'mainMedical'> | null | undefined): string {
  return typeof row?.mainMedical === 'string' ? row.mainMedical : '';
}

/** A lead's view of an event. */
export function eventAdmin(row: EventRow): EventAdmin {
  return {
    ...eventConfig(row),
    hasStaffPassword: row.hasStaffPassword,
    joinLinkExpiresAt: row.joinLinkExpiresAt,
    holdUntil: row.holdUntil ?? null,
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
  return { id: row.id, name: row.name, logoUrl: logoUrl(row), stage: 'archived' };
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

/** A sign-in team card, with the link name of the event it belongs to (a join link shows only its event's cards). */
export interface SignInTeam {
  label: string;
  short: string;
  medical: boolean;
  /** The event's slug. */
  event: string;
}

/**
 * The sign-in cards: the teams of every event in practice or live, in setup order (oldest event first), each with its
 * event's slug. A join link names its event, so its sign-in shows that event's cards only (components/signin/logic.ts
 * cardsFor). A password does not say which event it is until it signs in, so without a link the cards are every
 * running event's, each label once; the server then spells the team as the matched event does, or keeps it as Other
 * text. (Known follow-up: with two events running, a password sign-in can still pick the other event's team.)
 * [] when none can be read (the Other field still works).
 */
export async function signInTeams(): Promise<SignInTeam[]> {
  try {
    const { data, error } = await db().from('events').select('slug, teams').in('stage', ['practice', 'live']).order('created_at');
    if (error || !Array.isArray(data)) return [];
    const out: SignInTeam[] = [];
    for (const row of data as Array<{ slug?: unknown; teams?: unknown }>) {
      const event = str(row.slug).trim();
      const seen = new Set<string>();
      for (const t of Array.isArray(row.teams) ? (row.teams as Array<Partial<EventTeam>>) : []) {
        const label = str(t.label).trim();
        if (!label || seen.has(label.toLowerCase())) continue;
        seen.add(label.toLowerCase());
        out.push({ label, short: str(t.short).trim() || label, medical: t.medical === true, event });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** The event or 404. */
export async function requireEvent(eventId: string): Promise<EventRow> {
  const row = await loadEvent(eventId);
  if (!row) throw new ApiFailure('not_found');
  return row;
}

/**
 * `team` names this team: its label, its short name or (phase 2) a label it had before a rename, case-insensitive (so
 * "dispatch" typed as Other team is the event's Dispatch, whatever the event calls it in full).
 */
function teamNamed(x: Partial<EventTeam>, team: string): boolean {
  const t = team.trim().replace(/\s+/g, ' ').toLowerCase();
  return (
    str(x.label).toLowerCase() === t ||
    (!!x.short && str(x.short).toLowerCase() === t) ||
    (Array.isArray(x.aliases) && x.aliases.some((a) => typeof a === 'string' && a.toLowerCase() === t))
  );
}

/** True when `team` is one of the event's sign-in teams (by label or an earlier label, case-insensitive). */
export function isEventTeam(row: Pick<EventRow, 'teams'>, team: string): boolean {
  return (row.teams ?? []).some((x) => teamNamed(x, team));
}

/** The label of `team` as the event spells it now (an earlier label signs in as the renamed team). */
export function eventTeamLabel(row: Pick<EventRow, 'teams'>, team: string): string {
  return str((row.teams ?? []).find((x) => teamNamed(x, team))?.label, team);
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
  /**
   * Running (practice / live) events, and archived ones inside their 24 h grace period after End (stage archived:
   * a match is the Ended answer). An event that ended longer ago is never listed (lp_auth_secrets).
   */
  events: Array<{ id: string; stage: EventStage; hash: string }>;
  /** (Phase 3) The hashes ended events had: read by the lead passcode check only, never at sign-in. */
  retired?: string[];
}

export type PasswordMatch = { kind: 'lead'; version: number } | { kind: 'event'; eventId: string; stage: EventStage } | null;

/**
 * Sign-in with a password (spec "Server"): the lead passcode first; then each running event's staff password, and
 * each password an ended event still holds inside its 24 h grace period (stage archived: the caller answers Ended;
 * the uniqueness rule keeps a held password from being any other event's, so the order cannot matter).
 * A wrong password costs one bcrypt compare per running or held event, never per event ever ended: once the grace
 * period is over the hash is cleared, and that old password is just a wrong password. Its staff reach the Ended
 * screen through the old join link (matchEndedSlug) or an old session.
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
 * The uniqueness rule (spec "Server"): a staff password may not equal the lead passcode or another event's staff
 * password while that event runs or holds it (24 h after its End). The lead passcode may not equal ANY event's staff
 * password, ended ones included (their old hashes, `retired`): the lead passcode is checked first at sign-in, so an
 * old event's password would otherwise sign its staff in as lead. Throws 422 invalid (field `password` / `passcode`).
 * Returns the hashes it compared against: lp_event_set_password checks again, under a lock, that no other is in force.
 */
export async function assertSecretUnique(plain: string, target: { kind: 'event'; eventId: string } | { kind: 'lead' }): Promise<string[]> {
  const secrets = await rpc<AuthSecrets>('lp_auth_secrets', {});
  const field = target.kind === 'lead' ? 'passcode' : 'password';
  const clash = () => new ApiFailure('invalid', 'Choose a different password', { extra: { field } });
  const checked: string[] = [];
  if (target.kind === 'event') {
    if (secrets?.lead) checked.push(secrets.lead);
    if (await matches(plain, secrets?.lead)) throw clash();
  }
  for (const e of secrets?.events ?? []) {
    if (target.kind === 'event' && e.id === target.eventId) continue;
    checked.push(e.hash);
    if (await matches(plain, e.hash)) throw clash();
  }
  if (target.kind === 'lead') {
    for (const hash of secrets?.retired ?? []) if (await matches(plain, hash)) throw clash();
  }
  return checked;
}

/**
 * Sets an event's staff password under the uniqueness rule. If another event's password came into force between the
 * check and the write (a reopen kept its password, a lead changed one at that moment), the database refuses the write
 * (secrets_changed) and the check runs again with what is in force now. Three rounds at most.
 */
export async function setStaffPassword(eventId: string, plain: string): Promise<EventRow> {
  const hash = await hashSecret(plain);
  for (let round = 1; ; round++) {
    const checked = await assertSecretUnique(plain, { kind: 'event', eventId });
    try {
      return await rpc<EventRow>('lp_event_set_password', { p_event: eventId, p_hash: hash, p_checked: checked });
    } catch (e) {
      if (round >= 3 || !(e instanceof ApiFailure) || e.extra.currentStatus !== 'secrets_changed') throw e;
    }
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
 * (listed only inside its 24 h grace period) matches whatever its expiry, so it reaches the Ended screen.
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

/**
 * (Phase 3) A join link that matched no running or held event, whose slug names an archived event: its staff get the
 * Ended screen. After the grace period an ended event keeps no join code, so the slug is all there is to go on; that
 * tells nobody more than the event's name and logo, which its own logo route already serves. Null for anything else.
 */
export async function matchEndedSlug(raw: string): Promise<EventRow | null> {
  const { slug } = parseJoinToken(raw);
  if (!slug) return null;
  const row = await loadEventBySlug(slug);
  return row?.stage === 'archived' ? row : null;
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
