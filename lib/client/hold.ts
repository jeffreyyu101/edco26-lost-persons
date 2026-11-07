// (F5) The "Not found yet" hold on the client: what an answer tap shows before the server has answered, and
// the Undo bar's words. Pure: no React, no I/O (tests/unit/stages.test.ts, tests/unit/pending-v9.test.tsx). The
// server decides; these only predict it so a tapped card shows its "Not found yet" chip at once instead of
// flashing the closed status.
import type { RequestSummary } from '../api-types';
import { NOT_FOUND_YET_LABEL, RECHECK_MINUTES, STATUS, STATUS_META, initials, isHeld, notFoundHolds, type SettableStatus, type StatusKind } from '../domain';
import { formatCaseNumber } from '../format';

/** True when lp_set_status will put this request on hold for a Not found (see the rework SQL). */
export function holdsOnNotFound(row: Pick<RequestSummary, 'status' | 'notFoundChecks'>, kind: StatusKind): boolean {
  return notFoundHolds(row) && kind !== 'undo';
}

/** The hold fields a status change replaced: what lp_set_status's Undo puts back (rework.sql). */
export type HoldFields = Pick<RequestSummary, 'recheckAt' | 'notFoundChecks'>;

/** A row's hold fields as an Undo record keeps them (an older cache without them reads as no hold). */
export function holdFieldsOf(row: Partial<HoldFields>): HoldFields {
  return { recheckAt: row.recheckAt ?? null, notFoundChecks: row.notFoundChecks ?? 0 };
}

/**
 * The optimistic overlay of a status tap: the fields the server is expected to return. An Undo passes the hold
 * fields the undone change replaced (`restore`): the server puts them back, so the card comes back exactly as it
 * will be (the "Not found yet" chip and "× Not found" after the final Not found's Undo), not as a bare status.
 */
export function statusOverlayFields(row: RequestSummary, to: SettableStatus, kind: StatusKind, now: number, restore?: HoldFields | null): Partial<RequestSummary> {
  if (kind === 'undo' && restore) return { status: to, ...holdFieldsOf(restore) };
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

/** An Undo bar's visible words and what a screen reader hears (Pending v9.1). */
export interface SnackWords {
  message: string;
  said: string;
}

/**
 * The Undo bar after a Not found (Pending v9.1, Brian 2026-11-06): the first one, which put the request on hold,
 * reads "Not found yet · recheck in 20 min"; the final one "B.W. closed · not found in medical" (the closed
 * status's own label, so F2's rename flows through). Null for any other tap (the store's "LP-1012 · In medical").
 */
export function notFoundSnack(row: RequestSummary, to: SettableStatus): SnackWords | null {
  if (to !== STATUS.notInMedical) return null;
  if (isHeld(row)) {
    return {
      message: `${NOT_FOUND_YET_LABEL} · recheck in ${RECHECK_MINUTES} min`,
      said: `${NOT_FOUND_YET_LABEL}, recheck in ${RECHECK_MINUTES} minutes.`,
    };
  }
  if (row.status !== STATUS.notInMedical) return null;
  const who = initials(row.name) || formatCaseNumber(row.caseNumber);
  const closed = STATUS_META[STATUS.notInMedical].label.toLowerCase();
  return { message: `${who} closed · ${closed}`, said: `${who} closed, ${closed}.` };
}

/** The first Not found's Undo bar words (F5's name, kept for callers): "Not found yet · recheck in 20 min". */
export function holdSnackMessage(row: RequestSummary, to: SettableStatus): string | null {
  return to === STATUS.notInMedical && isHeld(row) ? (notFoundSnack(row, to)?.message ?? null) : null;
}
