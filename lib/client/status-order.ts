// Pending v9.1 (Brian 2026-11-06 19:35–20:40, design/screens/pending-v9.html): ONE status order, used by Pending
// (always) and by All requests and My requests when they are sorted by status. Pure: no React, no I/O
// (tests/unit/pending-v9.test.tsx). Only the views import it, so the first load (A25) does not carry it.
//
//   Waiting for check   every request Waiting for check, Needs info and "Not found yet" (held, due or not)
//                       included, longest wait first (wait = since it was logged). A hold is an indicator, not a
//                       lane: nothing moves when a recheck comes due.
//   Friend coming       In medical: Friend arrived (earliest arrival first) → Friend en route (soonest ETA
//                       first, no ETA last) → nobody coming (longest since found first).
//   Archived / Closed   every closed request, newest closed first (All folds it; My requests calls it Closed).
import type { RequestSummary } from '../api-types';
import { STATUS, isHeld, isInMedical, statusBucket, type GlyphKind } from '../domain';
import type { StageSource } from '../stages';

/** F3's en route summary, read loosely (rows of a build without F3 simply don't have it). */
const enrouteOf = (row: object): StageSource['enroute'] => (row as Pick<StageSource, 'enroute'>).enroute ?? null;

const time = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/** A time for sorting: unknown times sort as `fallback`. */
const at = (iso: string | null | undefined, fallback: number): number => {
  const t = time(iso);
  return Number.isFinite(t) ? t : fallback;
};

/** Rule 2: longest wait first (oldest logged first), ties by LP number. */
export function byLongestWait(a: RequestSummary, b: RequestSummary): number {
  return at(a.createdAt, 0) - at(b.createdAt, 0) || a.caseNumber - b.caseNumber;
}

/** Every request Waiting for check, longest wait first (Needs info and held requests in place). */
export function waitingOrder(rows: readonly RequestSummary[]): RequestSummary[] {
  return rows.filter((r) => r.status === STATUS.waiting).sort(byLongestWait);
}

/** Where a Friend coming request sits: 0 Friend arrived, 1 Friend en route, 2 nobody coming yet. */
export function comingRank(row: object): 0 | 1 | 2 {
  const state = enrouteOf(row)?.state;
  if (state === 'arrived') return 0;
  if (state === 'enroute') return 1;
  return 2;
}

/** When the In medical answer was given (the start of "since found"). */
const foundAt = (row: RequestSummary): number => at(row.reunionStartedAt ?? row.foundAt ?? row.updatedAt, 0);

/**
 * Rule 4, within Friend coming: Friend arrived, earliest arrival first (the arrival time when the server sends it,
 * else since found); Friend en route, soonest ETA first and no ETA last; In medical with nobody coming, longest
 * since found first. Ties by LP number.
 */
export function byFriendComing(a: RequestSummary, b: RequestSummary): number {
  const ra = comingRank(a);
  const rb = comingRank(b);
  if (ra !== rb) return ra - rb;
  const ea = enrouteOf(a);
  const eb = enrouteOf(b);
  if (ra === 0) {
    const d = at(ea?.arrivedAt, foundAt(a)) - at(eb?.arrivedAt, foundAt(b));
    if (d) return d;
  } else if (ra === 1) {
    const ta = time(ea?.earliestEta);
    const tb = time(eb?.earliestEta);
    const hasA = Number.isFinite(ta);
    const hasB = Number.isFinite(tb);
    if (hasA !== hasB) return hasA ? -1 : 1;
    if (hasA && hasB && ta !== tb) return ta - tb;
  }
  return foundAt(a) - foundAt(b) || a.caseNumber - b.caseNumber;
}

/** Every request In medical (legacy Bring friend included), in rule 4's order. */
export function friendComingOrder(rows: readonly RequestSummary[]): RequestSummary[] {
  return rows.filter((r) => isInMedical(r.status)).sort(byFriendComing);
}

/** When a closed request was closed (Not found in medical never sets closed_at: its last change). */
const closedAt = (row: RequestSummary): number => at(row.closedAt ?? row.updatedAt, 0);

/** Archived / Closed: newest closed first, ties by the higher LP number. */
export function byNewestClosed(a: RequestSummary, b: RequestSummary): number {
  return closedAt(b) - closedAt(a) || b.caseNumber - a.caseNumber;
}

export type StatusGroupKey = 'waiting' | 'coming' | 'closed';

/** A status group as its header or divider shows it: Pending's sections, the dividers of a list sorted by status. */
export type StatusGroupName = 'check' | 'coming' | 'closed';

export const STATUS_GROUP_META: Readonly<Record<StatusGroupName, { label: string; glyph: GlyphKind }>> = {
  check: { label: 'Waiting for check', glyph: 'waiting' },
  coming: { label: 'Friend coming', glyph: 'inMedical' },
  closed: { label: 'Archived', glyph: 'closed' },
};

export interface StatusGroups {
  waiting: RequestSummary[];
  coming: RequestSummary[];
  closed: RequestSummary[];
}

/**
 * Rows in status order, grouped: Waiting for check (rule 2), Friend coming (rule 4), then every closed request
 * (newest closed first). A status this app does not know (a legacy value) is open only if domain says so; open
 * legacy values other than Bring friend sort with Waiting for check.
 */
export function statusGroups(rows: readonly RequestSummary[]): StatusGroups {
  const waiting: RequestSummary[] = [];
  const coming: RequestSummary[] = [];
  const closed: RequestSummary[] = [];
  for (const row of rows) {
    // (Companion) Located · already accompanied sits with the other Located requests.
    if (isInMedical(row.status) || row.status === STATUS.accompanied) coming.push(row);
    else if (statusBucket(row.status) === 'open') waiting.push(row);
    else closed.push(row);
  }
  return { waiting: waiting.sort(byLongestWait), coming: coming.sort(byFriendComing), closed: closed.sort(byNewestClosed) };
}

/** The longest wait among `waiting`, in whole minutes at `now` (a folded Waiting header shows it), or null. */
export function oldestWaitMinutes(waiting: readonly RequestSummary[], now: number): number | null {
  let oldest = Number.POSITIVE_INFINITY;
  for (const row of waiting) {
    const t = time(row.createdAt);
    if (Number.isFinite(t) && t < oldest) oldest = t;
  }
  return Number.isFinite(oldest) ? Math.max(0, Math.floor((now - oldest) / 60_000)) : null;
}

/** The next moment a held request becomes due after `now` (epoch ms), or null: when a "Recheck due" chip appears. */
export function nextRecheckAt(rows: readonly RequestSummary[], now: number): number | null {
  let next: number | null = null;
  for (const row of rows) {
    if (!isHeld(row)) continue;
    const t = time(row.recheckAt);
    if (t > now && (next === null || t < next)) next = t;
  }
  return next;
}
