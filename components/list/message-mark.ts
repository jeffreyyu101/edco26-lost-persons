// The message lane's mark (design/screens/msg-indicator.html, Brian 2026-11-07; list-helpers.ts has the rules), on
// its own: the log rows, the desk table and the request page's CardActivity all draw it, and the request page must
// not load every list helper for it.
import type { RequestSummary } from '@/lib/api-types';
import { unreadOf } from '@/lib/messaging-activity';

/** The most the lane's bubble prints: 1, 12, 99, then "99+" (the 31 px lane fits "99+" and nothing wider). */
export const MARK_MAX = 99;

/** The bubble's text: "1", "12", "99", "99+". */
export function markCount(n: number): string {
  return n > MARK_MAX ? `${MARK_MAX}+` : String(n);
}

export type MessageMark = { kind: 'unread'; count: number; text: string } | { kind: 'read'; count: number } | null;

/**
 * What a row's message lane shows: the unread bubble (others' messages after my read cursor), else the read
 * outline while the request has messages, else nothing. Rows cached before F3 carry neither count: nothing.
 */
export function messageMark(row: Partial<Pick<RequestSummary, 'unread' | 'messageCount'>>): MessageMark {
  const unread = unreadOf(row);
  if (unread > 0) return { kind: 'unread', count: unread, text: markCount(unread) };
  const total = typeof row.messageCount === 'number' && row.messageCount > 0 ? row.messageCount : 0;
  return total > 0 ? { kind: 'read', count: total } : null;
}
