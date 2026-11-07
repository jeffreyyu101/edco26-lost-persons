// (F5) Pending > To check with the "Not found yet" hold (design/screens/recheck-2.png): due rechecks first (most
// overdue first), then the normal queue (oldest first), then "Later": held requests not due yet, by recheck time.
// To check counts due + queue; Later is not counted (selectors.viewCounts with `now`). Pure, and only the Pending
// views import it, so the first load (A25) does not carry it.
import type { RequestSummary } from '../api-types';
import { isHeld, isRecheckDue } from '../domain';

const time = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};


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
