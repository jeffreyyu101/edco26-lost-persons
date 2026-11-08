// (F5, Pending v9.1) The "Not found yet" hold on the client: what a status tap shows before the server has answered,
// the Undo bar's words, and the 409 resend check. Pure: no React, no I/O (tests/unit/stages.test.tsx,
// tests/unit/pending-v9.test.tsx, through lib/client/hold.ts). The server decides; these only predict it so a tapped
// card shows its "Not found yet" chip at once instead of flashing the closed status.
//
// The store loads this with import() (store-core.ts loadHold), so the first load of `/` (A25) does not carry it.
// It imports types only and is handed the domain values it uses (HoldDomain): an import() whose module reaches
// lib/domain.ts or lib/format.ts makes Turbopack split the first-load chunk those two live in, which cost about
// 1 KB gzipped on the F5 release build. lib/client/hold.ts binds it to lib/domain.ts for everything else.
import type { RequestSummary } from '../api-types';
import type * as Domain from '../domain';
import type { SettableStatus, StatusKind } from '../domain';
import type * as Format from '../format';

/** The domain values the rules use (lib/domain.ts, lib/format.ts). */
export interface HoldDomain {
  STATUS: typeof Domain.STATUS;
  STATUS_META: typeof Domain.STATUS_META;
  NOT_FOUND_YET_LABEL: typeof Domain.NOT_FOUND_YET_LABEL;
  RECHECK_MINUTES: typeof Domain.RECHECK_MINUTES;
  alertName: typeof Domain.alertName;
  isHeld: typeof Domain.isHeld;
  notFoundHolds: typeof Domain.notFoundHolds;
  formatCaseNumber: typeof Format.formatCaseNumber;
}

/** The hold fields a status change replaced: what lp_set_status's Undo puts back (rework.sql). */
export type HoldFields = Pick<RequestSummary, 'recheckAt' | 'notFoundChecks'>;

/** An Undo bar's visible words and what a screen reader hears (Pending v9.1). */
export interface SnackWords {
  message: string;
  said: string;
}

export function holdRules(d: HoldDomain) {
  const { STATUS, NOT_FOUND_YET_LABEL, RECHECK_MINUTES } = d;

  /** True when lp_set_status will put this request on hold for a Not found (see the rework SQL). */
  function holdsOnNotFound(row: Pick<RequestSummary, 'status' | 'notFoundChecks'>, kind: StatusKind): boolean {
    return d.notFoundHolds(row) && kind !== 'undo';
  }

  /** A row's hold fields as an Undo record keeps them (an older cache without them reads as no hold). */
  function holdFieldsOf(row: Partial<HoldFields>): HoldFields {
    return { recheckAt: row.recheckAt ?? null, notFoundChecks: row.notFoundChecks ?? 0 };
  }

  /**
   * The optimistic overlay of a status tap: the fields the server is expected to return. An Undo passes the hold
   * fields the undone change replaced (`restore`): the server puts them back, so the card comes back exactly as it
   * will be (the "Not found yet" chip and "× Not found" after the final Not found's Undo), not as a bare status.
   */
  function statusOverlayFields(row: RequestSummary, to: SettableStatus, kind: StatusKind, now: number, restore?: HoldFields | null): Partial<RequestSummary> {
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
  function holdChanged(a: Pick<RequestSummary, 'recheckAt' | 'notFoundChecks'>, b: Pick<RequestSummary, 'recheckAt' | 'notFoundChecks'>): boolean {
    return (a.recheckAt ?? null) !== (b.recheckAt ?? null) || (a.notFoundChecks ?? 0) !== (b.notFoundChecks ?? 0);
  }

  /**
   * The Undo bar after a Not found (Pending v9.1, Brian 2026-11-06): the first one, which put the request on hold,
   * reads "Not found yet · recheck in 20 min"; the final one "Bea Walsh closed · not located" (the closed
   * status's own label, so F2's rename flows through). Null for any other tap (the store's "LP-1012 · In medical").
   */
  function notFoundSnack(row: RequestSummary, to: SettableStatus): SnackWords | null {
    if (to !== STATUS.notInMedical) return null;
    if (d.isHeld(row)) {
      return {
        message: `${NOT_FOUND_YET_LABEL} · recheck in ${RECHECK_MINUTES} min`,
        said: `${NOT_FOUND_YET_LABEL}, recheck in ${RECHECK_MINUTES} minutes.`,
      };
    }
    if (row.status !== STATUS.notInMedical) return null;
    const who = d.alertName(row.name) || d.formatCaseNumber(row.caseNumber);
    const closed = d.STATUS_META[STATUS.notInMedical].label.toLowerCase();
    return { message: `${who} closed · ${closed}`, said: `${who} closed, ${closed}.` };
  }

  /** The first Not found's Undo bar words (F5's name, kept for callers): "Not found yet · recheck in 20 min". */
  function holdSnackMessage(row: RequestSummary, to: SettableStatus): string | null {
    return to === STATUS.notInMedical && d.isHeld(row) ? (notFoundSnack(row, to)?.message ?? null) : null;
  }

  return { holdsOnNotFound, holdFieldsOf, statusOverlayFields, holdChanged, notFoundSnack, holdSnackMessage };
}

export type HoldRules = ReturnType<typeof holdRules>;
