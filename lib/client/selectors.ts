// Pure derivations from the store state, shared by the real store, the stub and the hooks in
// store-contract.ts. No React, no I/O.
// FROZEN after Phase 1a: later phases may ADD exports, never change existing ones.
import type { OutboxItem, RequestSummary } from '../api-types';
import { STATUS, isHeld, isInMedical, isRecheckDue, matchesPostFilter, postFull, sameStaff, statusBucket } from '../domain';
import { formatCaseNumber, parseCaseNumberQuery } from '../format';
import type { Overlay } from './store-contract';

const time = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** A confirmed row with its optimistic overlay applied. */
export function applyOverlay(row: RequestSummary, overlay: Overlay | undefined): RequestSummary {
  return overlay ? { ...row, ...overlay.fields } : row;
}

/** Every row as the UI should show it (overlays applied), unsorted. */
export function mergedRows(
  confirmed: ReadonlyMap<string, RequestSummary>,
  pending: ReadonlyMap<string, Overlay>,
): RequestSummary[] {
  const out: RequestSummary[] = [];
  for (const [id, row] of confirmed) out.push(applyOverlay(row, pending.get(id)));
  return out;
}

/** All: chronological, newest first by createdAt (ties: higher LP number first). */
export function sortNewestFirst(rows: readonly RequestSummary[]): RequestSummary[] {
  return [...rows].sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.caseNumber - a.caseNumber);
}

export interface AllFilter {
  /** Database status value; In medical also matches the legacy Bring-friend status. */
  status: string | null;
  /**
   * A post filter key (domain.postFilterKey): the post value, or "Other:<where>". Never matches a
   * different post with the same short form.
   */
  post: string | null;
  /**
   * Only open requests (Waiting, In medical, legacy Bring friend). With `post`, these are exactly the rows
   * one dashboard "Open by post" bar counts (lp_stats byPost).
   */
  open?: boolean;
}

export function filterAll(rows: readonly RequestSummary[], filter: AllFilter): RequestSummary[] {
  const post = filter.post?.trim() || null;
  return rows.filter((r) => {
    if (filter.status) {
      const ok = filter.status === STATUS.inMedical ? isInMedical(r.status) : r.status === filter.status;
      if (!ok) return false;
    }
    if (post && !matchesPostFilter(r, post)) return false;
    if (filter.open && statusBucket(r.status) !== 'open') return false;
    return true;
  });
}

export interface PendingGroups {
  /** In medical (incl. legacy Bring friend), oldest first by reunionStartedAt. */
  friendComing: RequestSummary[];
  /** Waiting for check, oldest first by createdAt. */
  waiting: RequestSummary[];
}

export function pendingGroups(rows: readonly RequestSummary[]): PendingGroups {
  const friendComing = rows
    .filter((r) => isInMedical(r.status))
    .sort(
      (a, b) =>
        time(a.reunionStartedAt ?? a.foundAt ?? a.updatedAt) - time(b.reunionStartedAt ?? b.foundAt ?? b.updatedAt) ||
        a.caseNumber - b.caseNumber,
    );
  const waiting = rows
    .filter((r) => r.status === STATUS.waiting)
    .sort((a, b) => time(a.createdAt) - time(b.createdAt) || a.caseNumber - b.caseNumber);
  return { friendComing, waiting };
}

// ---------------------------------------------------------------------------------------------------
// (F5) Pending > To check with the "Not found yet" hold (design/screens/recheck-2.png): due rechecks first
// (most overdue first), then the normal queue (oldest first), then "Later": held requests not due yet, by
// recheck time. To check counts due + queue; Later is not counted.
// ---------------------------------------------------------------------------------------------------

export interface ToCheckLanes {
  /** Held requests whose recheck time has come, the earliest recheck first. */
  due: RequestSummary[];
  /** Waiting for check, not held, oldest first (as pendingGroups gives them). */
  queue: RequestSummary[];
  /** Held, not due yet, the earliest recheck first. */
  later: RequestSummary[];
}

const recheckOrder = (a: RequestSummary, b: RequestSummary) =>
  time(a.recheckAt) - time(b.recheckAt) || time(a.createdAt) - time(b.createdAt) || a.caseNumber - b.caseNumber;

/** Splits pendingGroups().waiting into the To check lanes at `now` (epoch ms). */
export function toCheckLanes(waiting: readonly RequestSummary[], now: number): ToCheckLanes {
  const due: RequestSummary[] = [];
  const queue: RequestSummary[] = [];
  const later: RequestSummary[] = [];
  for (const row of waiting) {
    if (!isHeld(row)) queue.push(row);
    else if (isRecheckDue(row, now)) due.push(row);
    else later.push(row);
  }
  return { due: due.sort(recheckOrder), queue, later: later.sort(recheckOrder) };
}

/** The next moment a held request becomes due after `now` (epoch ms), or null: when the lanes change next. */
export function nextRecheckAt(rows: readonly RequestSummary[], now: number): number | null {
  let next: number | null = null;
  for (const row of rows) {
    if (!isHeld(row)) continue;
    const t = time(row.recheckAt);
    if (t > now && (next === null || t < next)) next = t;
  }
  return next;
}

/** My requests = created on this phone ∪ canonical created_by match with the session staff. */
export function isMine(row: RequestSummary, myIds: ReadonlySet<string>, sessionStaff: string | null): boolean {
  return myIds.has(row.id) || sameStaff(row.createdBy, sessionStaff);
}

/** My requests, newest update first. */
export function mineRows(
  rows: readonly RequestSummary[],
  myIds: ReadonlySet<string>,
  sessionStaff: string | null,
): RequestSummary[] {
  return rows
    .filter((r) => isMine(r, myIds, sessionStaff))
    .sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || b.caseNumber - a.caseNumber);
}

/**
 * Outbox items to show at the top of All and My requests (v2.1 A6): hides any item whose mutationId
 * already matches a confirmed row's clientMutationId. Newest first.
 */
export function visibleOutbox(outbox: readonly OutboxItem[], confirmed: ReadonlyMap<string, RequestSummary>): OutboxItem[] {
  const sent = new Set<string>();
  for (const row of confirmed.values()) if (row.clientMutationId) sent.add(row.clientMutationId);
  return outbox.filter((item) => !sent.has(item.mutationId)).sort((a, b) => b.createdAt - a.createdAt);
}

export interface ViewCounts {
  all: number;
  pending: number;
  mine: number;
}

export function viewCounts(
  rows: readonly RequestSummary[],
  outboxShown: readonly OutboxItem[],
  myIds: ReadonlySet<string>,
  sessionStaff: string | null,
  /** (F5) With `now`, held requests not due yet (Pending's "Later") are not counted as pending. */
  now?: number,
): ViewCounts {
  const groups = pendingGroups(rows);
  const later = now === undefined ? 0 : toCheckLanes(groups.waiting, now).later.length;
  return {
    all: rows.length + outboxShown.length,
    pending: groups.friendComing.length + groups.waiting.length - later,
    mine: rows.filter((r) => isMine(r, myIds, sessionStaff)).length + outboxShown.length,
  };
}

// ---------------------------------------------------------------------------------------------------
// Search (spec §8): case-insensitive over name, clothing, last seen, physical description, identifying
// features, hair, post and the LP number ("1012" or "LP-1012"), the medical location ("Chair 14", 2026-11-06
// afternoon), and the free-text age ("mid-20s"; not for a query that reads as an LP number, so typing digits
// never lists everyone of that age).
// ---------------------------------------------------------------------------------------------------

export type SearchField =
  | 'name'
  | 'caseNumber'
  | 'clothing'
  | 'lastSeen'
  | 'physicalDescription'
  | 'identifyingFeatures'
  | 'hair'
  | 'post'
  | 'medicalLocation'
  | 'age';

export interface SearchHit {
  row: RequestSummary;
  /** The first field that matched, in the order above; its text is the snippet to show. */
  field: SearchField;
  text: string;
  /** [start, end) ranges of `text` to highlight. */
  ranges: Array<[number, number]>;
}

/** Case-insensitive occurrences of `query` in `text`, as [start, end) ranges. */
export function highlightRanges(text: string, query: string): Array<[number, number]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const t = text.toLowerCase();
  const out: Array<[number, number]> = [];
  for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) out.push([i, i + q.length]);
  return out;
}

/**
 * A field's text for search. sync-merge normalises a cached numeric age to text on load; this also keeps a
 * stray number (or any other non-string) from throwing in highlightRanges while the list renders.
 */
const searchableText = (value: unknown): string | null =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;

export function searchRequests(rows: readonly RequestSummary[], query: string): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const caseNumber = parseCaseNumberQuery(q);
  const hits: SearchHit[] = [];
  for (const row of rows) {
    if (caseNumber !== null) {
      // Exact LP number, or a prefix of at least 2 digits while typing ("10" → LP-10xx).
      const digits = String(caseNumber);
      const own = String(row.caseNumber);
      if (row.caseNumber === caseNumber || (digits.length >= 2 && own.startsWith(digits))) {
        const lp = formatCaseNumber(row.caseNumber);
        const at = lp.length - own.length;
        hits.push({ row, field: 'caseNumber', text: lp, ranges: [[at, at + Math.min(digits.length, own.length)]] });
        continue;
      }
    }
    const fields: Array<[SearchField, unknown]> = [
      ['name', row.name],
      ['clothing', row.clothing],
      ['lastSeen', row.lastSeen],
      ['physicalDescription', row.physicalDescription],
      ['identifyingFeatures', row.identifyingFeatures],
      ['hair', row.hair],
      ['post', `${row.postShort} · ${postFull(row.reportingLocation, row.otherLocation)}`],
      // Optional on rows cached before the field existed.
      ['medicalLocation', row.medicalLocation ?? null],
      // A row cached before age became text can still hold a number (24): searchableText reads it as "24".
      ['age', caseNumber === null ? row.age : null],
    ];
    for (const [field, value] of fields) {
      const text = searchableText(value);
      if (!text) continue;
      const ranges = highlightRanges(text, q);
      if (ranges.length > 0) {
        hits.push({ row, field, text, ranges });
        break;
      }
    }
  }
  return hits.sort((a, b) => time(b.row.createdAt) - time(a.row.createdAt) || b.row.caseNumber - a.row.caseNumber);
}

// ---------------------------------------------------------------------------------------------------
// All requests, log option B (Brian + Jeffrey, 2026-11-06): open requests first, and every closed one
// (Not in medical included) folded into one "Closed N" row.
// ---------------------------------------------------------------------------------------------------

export interface OpenClosed<T> {
  /** Waiting for check, In medical (and legacy Bring friend). */
  open: T[];
  /** Not in medical, Reunited, Discharged, Cancelled and any unknown legacy status. */
  closed: T[];
}

/** Splits requests into the open and closed buckets, keeping their order. */
export function splitOpenClosed<T extends Pick<RequestSummary, 'status'>>(rows: readonly T[]): OpenClosed<T> {
  const open: T[] = [];
  const closed: T[] = [];
  for (const row of rows) (statusBucket(row.status) === 'open' ? open : closed).push(row);
  return { open, closed };
}

/** The unfiltered log: open requests, then the folded closed ones, each newest first by createdAt. */
export function logSections(rows: readonly RequestSummary[]): OpenClosed<RequestSummary> {
  return splitOpenClosed(sortNewestFirst(rows));
}

/** My requests: open first, then the closed ones (the finished area), each newest update first. */
export function mineSections(
  rows: readonly RequestSummary[],
  myIds: ReadonlySet<string>,
  sessionStaff: string | null,
): OpenClosed<RequestSummary> {
  return splitOpenClosed(mineRows(rows, myIds, sessionStaff));
}
