// Pure merge rules for the store (spec §7 Sync / Mutations, v2.1 A11). No I/O.
import type { RequestPatch, RequestSummary } from '../api-types';
import { postShort, splitName } from '../domain';

/** Same content (shallow, every key). Equal-version rows from the 30 s overlap keep their identity. */
export function sameRow(a: RequestSummary, b: RequestSummary): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as Array<keyof RequestSummary>;
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

/**
 * Monotonic merge: a row replaces the stored one only when its rowVersion is greater than or equal to it.
 * Returns null when nothing changed, so the confirmed map (and every selector memo) keeps its identity.
 */
export function mergeRows(
  confirmed: ReadonlyMap<string, RequestSummary>,
  rows: readonly RequestSummary[],
): Map<string, RequestSummary> | null {
  let next: Map<string, RequestSummary> | null = null;
  for (const row of rows) {
    const current = (next ?? confirmed).get(row.id);
    if (current) {
      if (row.rowVersion < current.rowVersion) continue;
      if (row.rowVersion === current.rowVersion && sameRow(current, row)) continue;
    }
    next ??= new Map(confirmed);
    next.set(row.id, row);
  }
  return next;
}

/**
 * Full fetch: the result replaces `confirmed` entirely, except that a stored row with a HIGHER version wins
 * (a mutation answered while the pages loaded) and `keep` ids missing from the result survive (rows this
 * phone created or changed during the fetch).
 */
export function replaceAll(
  confirmed: ReadonlyMap<string, RequestSummary>,
  rows: readonly RequestSummary[],
  keep: ReadonlySet<string>,
): Map<string, RequestSummary> {
  const next = new Map<string, RequestSummary>();
  for (const row of rows) {
    const current = confirmed.get(row.id);
    if (current && current.rowVersion > row.rowVersion) next.set(row.id, current);
    else if (current && current.rowVersion === row.rowVersion && sameRow(current, row)) next.set(row.id, current);
    else next.set(row.id, row);
  }
  for (const id of keep) {
    const current = confirmed.get(id);
    if (current && !next.has(id)) next.set(id, current);
  }
  return next;
}

/** Reconcile (every 10th poll): ids the server has at a different version, or that are missing here. */
export function staleIds(confirmed: ReadonlyMap<string, RequestSummary>, versions: ReadonlyArray<readonly [string, number]>): string[] {
  const out: string[] = [];
  for (const entry of versions) {
    if (!Array.isArray(entry)) continue;
    const [id, version] = entry;
    if (typeof id !== 'string' || typeof version !== 'number') continue;
    if (confirmed.get(id)?.rowVersion !== version) out.push(id);
  }
  return out;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const cleanText = (v: string | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
};

/** The optimistic fields of an edit (same normalisation as the server: trim, '' → null). */
export function overlayForPatch(row: RequestSummary, patch: RequestPatch): Partial<RequestSummary> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === 'name') {
      const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') || null : null;
      const { firstName, lastName } = splitName(name);
      out['name'] = name ?? '';
      out['firstName'] = firstName;
      out['lastName'] = lastName;
    } else if (typeof value === 'string' || value === null) {
      out[key] = key === 'reportingLocation' ? value : cleanText(value);
    } else {
      out[key] = value;
    }
  }
  if ('reportingLocation' in out || 'otherLocation' in out) {
    const reporting = (out['reportingLocation'] as string | undefined) ?? row.reportingLocation;
    const other = 'otherLocation' in out ? (out['otherLocation'] as string | null) : row.otherLocation;
    out['postShort'] = postShort(reporting, other);
  }
  return out as Partial<RequestSummary>;
}

/** A RequestDetail's summary part (the detail endpoint returns the row too). */
export function summaryOf<T extends RequestSummary>(detail: T): RequestSummary {
  const { photos: _p, audit: _a, ...rest } = detail as T & { photos?: unknown; audit?: unknown };
  return rest as RequestSummary;
}

/** Minimal shape check of a row from the network (a broken proxy must not poison the cache). */
export function isRow(value: unknown): value is RequestSummary {
  const r = value as RequestSummary | null;
  return !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.rowVersion === 'number' && typeof r.status === 'string' && typeof r.caseNumber === 'number';
}
