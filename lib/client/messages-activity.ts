// What the store does with the F3 activity of synced rows (spec §18 A55, A56): carry it over a mutation
// answer that has none, and raise the in-app alert for a new message. Small on purpose: the store's first-load
// code imports this, while the messages engine (messages-core.ts) loads after start (messages-lazy.ts, A25).
import type { RequestSummary } from '../api-types';
import { initials, isInMedical } from '../domain';
import { hasActivity, unreadOf, type RequestActivity } from '../messaging-activity';
import type { AlertEvent } from './store-contract';

/** The activity fields of a row (zeros for a row without them). */
export function activityOf(row: RequestSummary): RequestActivity {
  return {
    messageCount: row.messageCount ?? 0,
    lastMessageAt: row.lastMessageAt ?? null,
    unread: unreadOf(row),
    needsInfo: row.needsInfo === true,
    lastMessage: row.lastMessage ?? null,
    enroute: row.enroute ?? null,
    involved: row.involved === true,
  };
}

/**
 * A row from a response that does not carry activity (a status or edit answer built by lp_row alone) keeps
 * the activity the client had, adjusted for what the status change implies: Needs info ends with any status
 * change, the "Not found yet" hold and its Undo included (status still Waiting for check, but the server
 * writes a status_changed audit row, which ends Needs info there too), and en route exists only In medical.
 */
export function carryActivity(previous: RequestSummary | undefined, next: RequestSummary): RequestSummary {
  if (!previous || hasActivity(next) || !hasActivity(previous)) return next;
  const a = activityOf(previous);
  const statusChanged =
    previous.status !== next.status ||
    (previous.recheckAt ?? null) !== (next.recheckAt ?? null) ||
    (previous.notFoundChecks ?? 0) !== (next.notFoundChecks ?? 0);
  return {
    ...next,
    ...a,
    needsInfo: statusChanged ? false : a.needsInfo,
    enroute: isInMedical(next.status) ? a.enroute : null,
  };
}

// ---------------------------------------------------------------------------------------------------
// Alerts (toast + chime while visible; F4's Web Push covers the background)
// ---------------------------------------------------------------------------------------------------

/** Key of a message alert: the same in every tab that raises it. */
export const messageAlertKey = (row: Pick<RequestSummary, 'id' | 'lastMessageAt'>) => `${row.id}:m:${row.lastMessageAt ?? ''}`;

export interface MessageAlert {
  alert: AlertEvent;
  key: string;
  /** The message's time (server time). */
  at: string;
}

/**
 * A new message from someone else, on a request I'm involved in, since the rows the store held. Call it
 * BEFORE merging. Marks every alerted key in `seen`. `open`: request ids whose thread is on screen (no
 * alert: the bubble is the alert). A held row without the activity fields (cached by a build before
 * messages, or a create answer) had no message this phone knew of: its first message alerts.
 */
export function diffMessageAlerts(
  previous: ReadonlyMap<string, RequestSummary>,
  rows: readonly RequestSummary[],
  seen: Set<string>,
  open: (id: string) => boolean,
): MessageAlert[] {
  const out: MessageAlert[] = [];
  for (const row of rows) {
    if (!hasActivity(row) || !row.lastMessage || row.lastMessage.mine || !row.involved) continue;
    if (unreadOf(row) === 0 || !row.lastMessageAt) continue;
    const before = previous.get(row.id);
    if (!before) continue;
    const beforeAt = hasActivity(before) ? before.lastMessageAt : null;
    if (beforeAt && row.lastMessageAt <= beforeAt) continue;
    const key = messageAlertKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    if (open(row.id)) continue;
    const who = initials(row.name);
    const subtitle = `${row.lastMessage.by || 'Staff'}: ${row.lastMessage.text}`;
    out.push({ key, at: row.lastMessageAt, alert: { kind: 'message', requestId: row.id, title: who || 'New message', subtitle, count: 1 } });
  }
  return out;
}
