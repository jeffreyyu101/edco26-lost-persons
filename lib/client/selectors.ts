// Pure derivations from the store state, shared by the real store, the stub and the hooks in
// store-contract.ts. No React, no I/O.
// FROZEN after Phase 1a: later phases may ADD exports, never change existing ones.
import type { OutboxItem, RequestSummary } from '../api-types';
import { STATUS, isInMedical, matchesPostFilter, postFull, sameStaff } from '../domain';
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
   * A post filter key (domain.postFilterKey): the post value, or "Other:<where>". Matches the rows one
   * dashboard bar counts, never a different post with the same short form.
   */
  post: string | null;
}

export function filterAll(rows: readonly RequestSummary[], filter: AllFilter): RequestSummary[] {
  const post = filter.post?.trim() || null;
  return rows.filter((r) => {
    if (filter.status) {
      const ok = filter.status === STATUS.inMedical ? isInMedical(r.status) : r.status === filter.status;
      if (!ok) return false;
    }
    if (post && !matchesPostFilter(r, post)) return false;
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
): ViewCounts {
  const groups = pendingGroups(rows);
  return {
    all: rows.length + outboxShown.length,
    pending: groups.friendComing.length + groups.waiting.length,
    mine: rows.filter((r) => isMine(r, myIds, sessionStaff)).length + outboxShown.length,
  };
}

// ---------------------------------------------------------------------------------------------------
// Search (spec §8): case-insensitive over name, clothing, last seen, physical description, identifying
// features, hair, post and the LP number ("1012" or "LP-1012").
// ---------------------------------------------------------------------------------------------------

export type SearchField =
  | 'name'
  | 'caseNumber'
  | 'clothing'
  | 'lastSeen'
  | 'physicalDescription'
  | 'identifyingFeatures'
  | 'hair'
  | 'post';

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
    const fields: Array<[SearchField, string | null]> = [
      ['name', row.name],
      ['clothing', row.clothing],
      ['lastSeen', row.lastSeen],
      ['physicalDescription', row.physicalDescription],
      ['identifyingFeatures', row.identifyingFeatures],
      ['hair', row.hair],
      ['post', `${row.postShort} · ${postFull(row.reportingLocation, row.otherLocation)}`],
    ];
    for (const [field, text] of fields) {
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
