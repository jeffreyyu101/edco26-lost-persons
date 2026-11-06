// In-app alerts (spec §7 Alerts). Pure: which incoming rows alert, their copy, and burst coalescing.
//   * My requests (created on this phone, or canonical created_by = me): any status change made by someone else.
//   * New requests by others: only while the bell is on.
//   * Never for this phone's own mutations; never for the first sync after load (the store's baseline).
//   * Each alert is keyed by (id, rowVersion); more than 2 at once become one "3 updates" toast.
import type { RequestSummary } from '../api-types';
import { STATUS, ageGender, initials, isInMedical, sameStaff, statusMeta } from '../domain';
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
}

export const alertKey = (row: Pick<RequestSummary, 'id' | 'rowVersion'>) => `${row.id}:${row.rowVersion}`;

/** "LP-1004 · S.L." (just "LP-1004" when there is no name). */
function subject(row: RequestSummary): string {
  const who = initials(row.name);
  const lp = formatCaseNumber(row.caseNumber);
  return who ? `${lp} · ${who}` : lp;
}

export function statusAlert(row: RequestSummary): AlertEvent {
  const s = subject(row);
  if (isInMedical(row.status)) {
    return { kind: 'in_medical', requestId: row.id, title: `${s} is in medical`, subtitle: 'Bring the friend to Main Med', count: 1 };
  }
  if (row.status === STATUS.notInMedical) return { kind: 'not_in_medical', requestId: row.id, title: `${s} — not in medical`, count: 1 };
  if (row.status === STATUS.reunited) return { kind: 'reunited', requestId: row.id, title: `${s} reunited`, count: 1 };
  return { kind: 'status_changed', requestId: row.id, title: `${s} — ${statusMeta(row.status).shortLabel.toLowerCase()}`, count: 1 };
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
      if (before.status === row.status || !mine || byMe) continue;
      ctx.seen.add(key);
      out.push(statusAlert(row));
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
      // Front of house has to act on this one (walk the friend to Main Med): it stays until dismissed.
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
  }
}
