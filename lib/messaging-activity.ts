// The activity fields a RequestSummary carries for messages and en route (F3, spec §18 A55), and the two
// questions the store asks of every synced row. Tiny on purpose: the store's first-load code imports this,
// while the rest of lib/messaging.ts loads with the screens (spec §7 Performance, A25).
import type { RequestSummary } from './api-types';

/** The activity fields of a RequestSummary (all optional: rows cached before this build have none). */
export const ACTIVITY_KEYS = ['messageCount', 'lastMessageAt', 'unread', 'needsInfo', 'lastMessage', 'enroute', 'involved'] as const;
export type ActivityKey = (typeof ACTIVITY_KEYS)[number];
export type RequestActivity = Required<Pick<RequestSummary, ActivityKey>>;

/** No messages, nobody en route. */
export const EMPTY_ACTIVITY: RequestActivity = {
  messageCount: 0,
  lastMessageAt: null,
  unread: 0,
  needsInfo: false,
  lastMessage: null,
  enroute: null,
  involved: false,
};

/** True when the row carries activity fields (a row from this build's sync or detail). */
export function hasActivity(row: Partial<Pick<RequestSummary, 'messageCount'>>): boolean {
  return typeof row.messageCount === 'number';
}

/** The row's unread count (0 for rows without activity). */
export function unreadOf(row: Pick<RequestSummary, 'unread'>): number {
  return typeof row.unread === 'number' && row.unread > 0 ? row.unread : 0;
}
