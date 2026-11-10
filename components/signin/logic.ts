// Pure sign-in logic (spec §8 Sign-in, §6 POST /api/session, A27/A28/A29). No React, no fetch, no zod:
// /signin stays light. tests/unit/signin-logic.test.ts checks these rules against lib/validation's
// signInSchema so the client never enables Continue for something the server would refuse.
import type { EndedEvent, SessionInfo } from '@/lib/api-types';
import {
  OTHER_TEAM,
  OTHER_TEAM_MAX,
  OTHER_TEAM_MIN,
  STAFF_FORBIDDEN_CHARS,
  STAFF_NAME_MAX,
  STAFF_NAME_MIN,
} from '@/lib/domain';
import type { Prefs } from '@/lib/client/prefs';
import type { SignInBody } from '@/lib/validation';

/** The staff identity signing in: the name and the canonical team (a card value or the Other text). */
export interface Identity {
  name: string;
  team: string;
}

/**
 * (Events) A sign-in card: one team of the events running now (the server page reads them; no event is known before a
 * password or join link signs in). `label` is what the session stores.
 */
export interface SignInTeam {
  label: string;
  short: string;
  medical: boolean;
}

/** Step 1 as typed. `team` is the chosen card's label; `otherTeam` the free text (they are mutually exclusive). */
export interface WhoDraft {
  name: string;
  team: string | null;
  otherTeam: string;
}

export const EMPTY_DRAFT: WhoDraft = Object.freeze({ name: '', team: null, otherTeam: '' }) as WhoDraft;

/** Same normalisation as the server (validation.ts staffText): trim and collapse whitespace. */
export function collapse(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

const codePoints = (s: string) => Array.from(s).length;

export const FORBIDDEN_CHAR_MESSAGE = 'Remove the “·” character';

export interface WhoCheck {
  /** Set when Continue may be pressed. */
  identity: Identity | null;
  /** Shown under the name field (only for things the user can't otherwise see, e.g. a "·"). */
  nameError: string | null;
  /** Shown under the Other team field. */
  otherTeamError: string | null;
}

/**
 * Step 1 validity (spec §8: Continue is disabled until the name has 2+ characters and a team is chosen).
 * Mirrors signInSchema: name 2–60 code points, Other team 2–80, no "·"/"•" or control characters.
 */
export function checkWho(draft: WhoDraft, teams: readonly SignInTeam[] = []): WhoCheck {
  const name = collapse(draft.name);
  const other = collapse(draft.otherTeam);
  const nameError = STAFF_FORBIDDEN_CHARS.test(name) ? FORBIDDEN_CHAR_MESSAGE : null;
  const otherTeamError = !draft.team && STAFF_FORBIDDEN_CHARS.test(other) ? FORBIDDEN_CHAR_MESSAGE : null;
  const nameOk = !nameError && codePoints(name) >= STAFF_NAME_MIN && codePoints(name) <= STAFF_NAME_MAX;

  let team: string | null = null;
  if (draft.team) team = draft.team;
  else if (!otherTeamError && codePoints(other) >= OTHER_TEAM_MIN && codePoints(other) <= OTHER_TEAM_MAX) {
    // (Events) Text naming one of the cards (its label or short name, any case: "dispatch") is that card; anything else
    // stays as typed (the server then spells it as the matched event does when it is one of its teams).
    team = cardFor(other, teams) ?? other;
  }
  return { identity: nameOk && team ? { name, team } : null, nameError, otherTeamError };
}

/** Step 1 prefilled from an identity (after "Change"): a card when the team is one, else the Other text. */
export function draftFromIdentity(identity: Identity | null, teams: readonly SignInTeam[] = []): WhoDraft {
  if (!identity) return { ...EMPTY_DRAFT };
  const card = cardFor(identity.team, teams);
  return { name: identity.name, team: card, otherTeam: card ? '' : identity.team };
}

/** The card a team is (by its label or short name, case-insensitive), or null. */
export function cardFor(team: string, teams: readonly SignInTeam[]): string | null {
  const t = collapse(team).toLowerCase();
  return teams.find((x) => x.label.toLowerCase() === t || x.short.toLowerCase() === t)?.label ?? null;
}

/** Remembered name and team (both or neither) skip straight to step 2 (spec §8, A29). */
export function rememberedIdentity(prefs: Pick<Prefs, 'rememberedName' | 'rememberedTeam'>): Identity | null {
  return prefs.rememberedName && prefs.rememberedTeam ? { name: prefs.rememberedName, team: prefs.rememberedTeam } : null;
}

/** The identity part of a POST /api/session body: a card label as `team`, anything else as Other + `otherTeam`. */
function identityBody(identity: Identity, teams: readonly SignInTeam[]): Pick<SignInBody, 'staffName' | 'team' | 'otherTeam'> {
  const card = cardFor(identity.team, teams);
  return card ? { staffName: identity.name, team: card } : { staffName: identity.name, team: OTHER_TEAM, otherTeam: identity.team };
}

/** The POST /api/session body with the event password. */
export function signInBody(identity: Identity, password: string, teams: readonly SignInTeam[] = []): SignInBody {
  return { ...identityBody(identity, teams), password };
}

/** The POST /api/session body with a team join link's code instead of the password (J1). */
export function inviteSignInBody(identity: Identity, invite: string, teams: readonly SignInTeam[] = []): SignInBody {
  return { ...identityBody(identity, teams), invite };
}

// ---------------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------------

/** When the server gives no retry time for a 429: the login window (lp_login_begin counts 15 min). */
export const DEFAULT_RETRY_SECONDS = 15 * 60;

export type SignInOutcome =
  /** Signed in. `session` is the SessionInfo body, or null if it was unreadable (the cookie is set). */
  | { kind: 'ok'; session: SessionInfo | null }
  /** 401: wrong event password (or a team link the server refused). */
  | { kind: 'password' }
  /** 429: too many attempts for this name + network. */
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  /** 400 / 422: the server refused the name or team. `message` is the server's (safe to show). */
  | { kind: 'invalid'; message: string }
  /** 403 (Origin check) — a stale or proxied page. */
  | { kind: 'forbidden' }
  /** (Events) 410 event_ended: the password or link is an archived event's. `event`: what the Ended screen shows. */
  | { kind: 'ended'; event: EndedEvent | null }
  /** 5xx or anything unexpected. */
  | { kind: 'server' }
  /** No response (offline, timeout, DNS…). */
  | { kind: 'network' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readSession(body: unknown): SessionInfo | null {
  if (!isRecord(body)) return null;
  const { staffName, team, staff, expiresAt, role, eventId, event } = body;
  if (typeof staffName !== 'string' || typeof team !== 'string') return null;
  return {
    role: role === 'lead' ? 'lead' : 'staff',
    eventId: typeof eventId === 'string' ? eventId : null,
    event: isRecord(event) ? (event as unknown as SessionInfo['event']) : null,
    staffName,
    team,
    staff: typeof staff === 'string' ? staff : `${staffName} · ${team}`,
    expiresAt: typeof expiresAt === 'string' ? expiresAt : '',
  };
}

/** The ended event an `event_ended` answer carries (name, logo), or null. */
export function readEnded(value: unknown): EndedEvent | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  return { name: value.name, logoUrl: typeof value.logoUrl === 'string' ? value.logoUrl : null, stage: 'archived' };
}

function errorField(body: unknown): Record<string, unknown> | null {
  return isRecord(body) && isRecord(body.error) ? body.error : null;
}

/** Retry-After as delta-seconds or an HTTP date; null when absent or unreadable. */
export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - nowMs) / 1000));
}

const MAX_SHOWN_MESSAGE = 160;

/** Maps a POST /api/session response to what the screen shows. */
export function interpretSignInResponse(status: number, body: unknown, retryAfterHeader: string | null, nowMs: number): SignInOutcome {
  if (status >= 200 && status < 300) return { kind: 'ok', session: readSession(body) };
  const error = errorField(body);
  if (status === 401) return { kind: 'password' };
  if (status === 429) {
    const fromBody = typeof error?.retryAfterSeconds === 'number' && Number.isFinite(error.retryAfterSeconds) ? error.retryAfterSeconds : null;
    const seconds = fromBody ?? parseRetryAfter(retryAfterHeader, nowMs) ?? DEFAULT_RETRY_SECONDS;
    return { kind: 'rate_limited', retryAfterSeconds: Math.max(1, Math.ceil(seconds)) };
  }
  if (status === 400 || status === 422) {
    const message = typeof error?.message === 'string' ? error.message.trim() : '';
    return { kind: 'invalid', message: message && message.length <= MAX_SHOWN_MESSAGE ? message : 'Check your name and team' };
  }
  if (status === 403) return { kind: 'forbidden' };
  if (status === 410 && error?.code === 'event_ended') return { kind: 'ended', event: readEnded(error.event) };
  return { kind: 'server' };
}

/** Whole minutes left, rounded up, at least 1: "Try again in N min". */
export function retryMinutes(secondsLeft: number): number {
  return Math.max(1, Math.ceil(secondsLeft / 60));
}

export const MESSAGES = {
  password: 'Incorrect password',
  rateLimited: (minutes: number) => `Too many attempts. Try again in ${minutes} min`,
  network: 'Couldn’t sign in — check signal and try again',
  server: 'Couldn’t sign in — try again',
  forbidden: 'Couldn’t sign in — reload the page and try again',
} as const;
