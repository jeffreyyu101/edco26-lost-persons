// In-app alerts (spec §7 Alerts). Pure: which incoming rows alert, their copy, and burst coalescing.
//   * My requests (created on this phone, or canonical created_by = me): any status change made by someone else.
//   * New requests by others: only while the bell is on.
//   * Never for this phone's own mutations; never for the first sync after load (the store's baseline).
//   * Each alert is keyed by (id, rowVersion); more than 2 at once become one "3 updates" toast.
//   * One alert toast per request: a later alert for it replaces the earlier toast, and a status toast
//     closes once the row is in another status (alertStillCurrent), so a sticky "is in medical" never
//     outlives a changed or undone answer. (F5) Going on hold or off it counts as a change too: the "Not
//     found yet" alert closes when its Undo takes the hold away.
//   * (F5) The hold's alert names the request by its initials only, never its LP number (contract B: it may
//     reach the lock screen): "K.T." / "Not found yet · recheck 4:40 PM".
//   * (F6) A backlog auto-close (row.quietClose: the first run after the migration, or after the job was paused)
//     never alerts, as the server never tells it: no toast, no system notification, no burst on the deploy.
import type { RequestSummary } from '../api-types';
import { STATUS, ageGender, initials, isHeld, isInMedical, sameStaff, statusMeta } from '../domain';
import { holdDetail } from '../hold-detail';
import { formatCaseNumber } from '../format';
import type { AlertEvent, ToastItem } from './store-contract';

export interface AlertContext {
  /** Attribution string of the signed-in staff. */
  sessionStaff: string | null;
  /** Request ids created on this phone. */
  myIds: ReadonlySet<string>;
  /** clientMutationIds of this phone's creates (the outbox), for rows that arrive before their id is known. */
  ownMutationIds: ReadonlySet<string>;
  /** `${id}:${rowVersion}` of this phone's own mutation results. */
  ownKeys: ReadonlySet<string>;
  /** New-request alerts (the bell). */
  bell: boolean;
  /** `${id}:${rowVersion}` already alerted (mutated: keys are added). */
  seen: Set<string>;
  /** (F5) The event timezone, for a hold's recheck time. */
  timeZone?: string;
}

export const alertKey = (row: Pick<RequestSummary, 'id' | 'rowVersion'>) => `${row.id}:${row.rowVersion}`;

/** "LP-1004 · S.L." (just "LP-1004" when there is no name). */
function subject(row: RequestSummary): string {
  const who = initials(row.name);
  const lp = formatCaseNumber(row.caseNumber);
  return who ? `${lp} · ${who}` : lp;
}

/**
 * (HIPAA, Brian 2026-11-07 14:18) The line under "<initials> located" in the in-app alert and the page's own system
 * notification. It never names Main Med (or any medical place): "Bring the friend to Main Med" said where the
 * named person is.
 */
export const LOCATED_SUBTITLE = 'Friend can head over';

export function statusAlert(row: RequestSummary, timeZone?: string): AlertEvent {
  // (F5) An Undo of the final Not found, or of In medical, can put the hold back: it reads "Not located yet".
  if (isHeld(row)) return holdAlert(row, timeZone);
  const s = subject(row);
  if (isInMedical(row.status)) {
    return { kind: 'in_medical', requestId: row.id, title: `${s} ${statusMeta(STATUS.inMedical).shortLabel.toLowerCase()}`, subtitle: LOCATED_SUBTITLE, count: 1 };
  }
  if (row.status === STATUS.notInMedical) {
    return { kind: 'not_in_medical', requestId: row.id, title: `${s} — ${statusMeta(STATUS.notInMedical).shortLabel.toLowerCase()}`, count: 1 };
  }
  if (row.status === STATUS.reunited) return { kind: 'reunited', requestId: row.id, title: `${s} reunited`, count: 1 };
  return { kind: 'status_changed', requestId: row.id, title: `${s} — ${statusMeta(row.status).shortLabel.toLowerCase()}`, count: 1 };
}

/** (F5) The title of a request with no name to take initials from (as F4's Activity rows). */
export const HOLD_ALERT_UNNAMED = 'Request';

/**
 * (F5) "K.T." / "Not found yet · recheck 4:40 PM": the first Not found put the request on hold (recheck-6.png).
 * Initials and nouns only (contract B), no LP number: the system notification shows the same words.
 */
export function holdAlert(row: RequestSummary, timeZone?: string): AlertEvent {
  return { kind: 'status_changed', requestId: row.id, title: initials(row.name) || HOLD_ALERT_UNNAMED, subtitle: holdDetail(row.recheckAt, timeZone), count: 1 };
}

export function newRequestAlert(row: RequestSummary): AlertEvent {
  const who = [initials(row.name), ageGender(row.age, row.gender)].filter(Boolean).join(' ');
  const subtitle = [who, row.postShort].filter(Boolean).join(' · ');
  return { kind: 'new_request', requestId: row.id, title: `New request · ${formatCaseNumber(row.caseNumber)}`, ...(subtitle ? { subtitle } : {}), count: 1 };
}

/**
 * The alerts for a batch of incoming rows, compared with what the store held before applying them.
 * Call it BEFORE merging the rows. Marks every alerted (id, rowVersion) in ctx.seen.
 */
export function diffAlerts(
  previous: ReadonlyMap<string, RequestSummary>,
  rows: readonly RequestSummary[],
  ctx: AlertContext,
): AlertEvent[] {
  const out: AlertEvent[] = [];
  for (const row of rows) {
    const key = alertKey(row);
    if (ctx.seen.has(key) || ctx.ownKeys.has(key)) continue;
    const before = previous.get(row.id);
    if (before && row.rowVersion <= before.rowVersion) continue;
    const mine = ctx.myIds.has(row.id) || sameStaff(row.createdBy, ctx.sessionStaff);
    // A change by the same person (another of their phones) is not "someone else".
    const byMe = sameStaff(row.updatedBy, ctx.sessionStaff);
    if (before) {
      if (!mine || byMe) continue;
      if (row.quietClose === true && before.status !== row.status) continue;
      if (before.status === row.status) {
        // (F5) The first Not found keeps the request Waiting for check: going on hold is the change.
        if (isHeld(row) && !isHeld(before)) {
          ctx.seen.add(key);
          out.push(holdAlert(row, ctx.timeZone));
        }
        continue;
      }
      ctx.seen.add(key);
      out.push(statusAlert(row, ctx.timeZone));
    } else {
      if (!ctx.bell || mine || byMe) continue;
      if (row.clientMutationId && ctx.ownMutationIds.has(row.clientMutationId)) continue;
      if (row.status !== STATUS.waiting) continue;
      ctx.seen.add(key);
      out.push(newRequestAlert(row));
    }
  }
  return out;
}

/** An alert together with the status of the row that raised it. */
export interface RaisedAlert {
  alert: AlertEvent;
  /** The row's status when the alert was raised (null for alerts with no request). */
  status: string | null;
  /** (F5) Whether the row was on a "Not found yet" hold then (domain isHeld). */
  held?: boolean;
  /** `${id}:${rowVersion}` of the row that raised it: the same in every tab that raises this alert. */
  key: string;
  /** The row's updatedAt (server time): when the change happened. */
  at?: string;
}

/** The alerts of `rows`, each paired with the status of the row that raised it (see diffAlerts). */
export function diffRaisedAlerts(
  previous: ReadonlyMap<string, RequestSummary>,
  rows: readonly RequestSummary[],
  ctx: AlertContext,
): RaisedAlert[] {
  const out: RaisedAlert[] = [];
  for (const row of rows) {
    for (const alert of diffAlerts(previous, [row], ctx)) out.push({ alert, status: row.status, held: isHeld(row), key: alertKey(row), at: row.updatedAt });
  }
  return out;
}

/**
 * One alert per request: when a batch (a reconnect, several pages) holds two changes of the same request,
 * only the later one is still true. Keeps the order of the surviving alerts.
 */
export function latestPerRequest<T extends { alert: AlertEvent }>(items: readonly T[]): T[] {
  const last = new Map<string, number>();
  items.forEach((item, i) => {
    if (item.alert.requestId) last.set(item.alert.requestId, i);
  });
  return items.filter((item, i) => !item.alert.requestId || last.get(item.alert.requestId) === i);
}

/**
 * Whether an alert toast still tells the truth about its request. A status alert ("is in medical") is out
 * of date as soon as the row is in another status (the answer was changed or undone), so it must not stay
 * on screen. A new-request alert is about the request being logged, which stays true. (F5) `alertedHeld`:
 * whether the row was on hold when the alert was raised; a hold taken away (the first Not found undone) or
 * put back leaves the status as it was, but the alert is out of date all the same.
 */
export function alertStillCurrent(
  kind: AlertEvent['kind'],
  alertedStatus: string | null,
  row: Pick<RequestSummary, 'status' | 'recheckAt'> | undefined,
  alertedHeld?: boolean,
): boolean {
  if (!row || kind === 'new_request' || kind === 'combined') return true;
  if (alertedHeld !== undefined && isHeld(row) !== alertedHeld) return false;
  if (kind === 'in_medical') return isInMedical(row.status);
  if (alertedStatus === null) return true;
  return row.status === alertedStatus || (isInMedical(row.status) && isInMedical(alertedStatus));
}

/** More than 2 alerts at once (a reconnect) combine into one "N updates" alert. */
export function coalesceAlerts(alerts: readonly AlertEvent[]): AlertEvent[] {
  if (alerts.length <= 2) return [...alerts];
  return [{ kind: 'combined', title: `${alerts.length} updates`, count: alerts.length }];
}

export const ALERT_TOAST_MS = 12_000;

/** The toast an alert shows (the toast carries the alert on its own; sound and vibration are extras). */
export function alertToast(alert: AlertEvent, view: (id: string) => void): Omit<ToastItem, 'id'> {
  const action = alert.requestId ? { label: 'View', run: () => view(alert.requestId as string) } : undefined;
  const base = { title: alert.title, ...(alert.subtitle ? { subtitle: alert.subtitle } : {}), ...(action ? { action } : {}) };
  switch (alert.kind) {
    case 'in_medical':
      // Front of house has to act on this one (walk the friend over): it stays until dismissed.
      return { ...base, tone: 'green', icon: 'check', durationMs: null };
    case 'not_in_medical':
      return { ...base, tone: 'amber', icon: 'x', durationMs: ALERT_TOAST_MS };
    case 'reunited':
      return { ...base, tone: 'neutral', icon: 'check', durationMs: ALERT_TOAST_MS };
    case 'new_request':
      return { ...base, tone: 'neutral', icon: 'bell', durationMs: ALERT_TOAST_MS };
    case 'status_changed':
      return { ...base, tone: 'neutral', icon: 'info', durationMs: ALERT_TOAST_MS };
    case 'combined':
      return { ...base, tone: 'neutral', icon: 'bell', durationMs: ALERT_TOAST_MS };
    case 'message':
      // F3: a new message from someone else on a request I'm involved in ("J.D." / "Rae C.: Any tattoos?").
      return { ...base, tone: 'blue', icon: 'message', durationMs: ALERT_TOAST_MS };
  }
}
