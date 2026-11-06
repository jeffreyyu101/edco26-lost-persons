// (F5) The "Not found yet" hold on the client: what an answer tap shows before the server has answered, and
// the Undo bar's words. Pure: no React, no I/O (tests/unit/stages.test.ts). The server decides; these only
// predict it so a tapped card moves straight to Later instead of flashing "Not in medical".
import type { RequestSummary } from '../api-types';
import { RECHECK_MINUTES, STATUS, actionLabel, isHeld, type SettableStatus, type StatusKind } from '../domain';
import { formatClock } from '../format';

/** True when lp_set_status will put this request on hold for a Not found (see the rework SQL). */
export function holdsOnNotFound(row: Pick<RequestSummary, 'status' | 'notFoundChecks'>, kind: StatusKind): boolean {
  return row.status === STATUS.waiting && (row.notFoundChecks ?? 0) === 0 && kind !== 'undo';
}

/** The optimistic overlay of a status tap: the fields the server is expected to return. */
export function statusOverlayFields(row: RequestSummary, to: SettableStatus, kind: StatusKind, now: number): Partial<RequestSummary> {
  if (to === STATUS.notInMedical) {
    if (holdsOnNotFound(row, kind)) return { recheckAt: new Date(now + RECHECK_MINUTES * 60_000).toISOString(), notFoundChecks: 1 };
    return { status: to, recheckAt: null };
  }
  if (to === STATUS.inMedical) return { status: to, recheckAt: null };
  if (to === STATUS.waiting && kind !== 'undo') return { status: to, recheckAt: null, notFoundChecks: 0 };
  return { status: to };
}

/** The request went on hold, came off it, or moved to another round between `a` and `b`. */
export function holdChanged(a: Pick<RequestSummary, 'recheckAt' | 'notFoundChecks'>, b: Pick<RequestSummary, 'recheckAt' | 'notFoundChecks'>): boolean {
  return (a.recheckAt ?? null) !== (b.recheckAt ?? null) || (a.notFoundChecks ?? 0) !== (b.notFoundChecks ?? 0);
}

/**
 * The Undo bar after a tap: "Not found · recheck 4:40" for the first Not found (the label of the answer button,
 * so the rename to "Not found" flows through), else null (the store's own "LP-1012 · In medical").
 */
export function holdSnackMessage(row: RequestSummary, to: SettableStatus, timeZone: string): string | null {
  if (to !== STATUS.notInMedical || !isHeld(row)) return null;
  return `${actionLabel('notInMedical')} · recheck ${formatClock(row.recheckAt as string, timeZone)}`;
}
