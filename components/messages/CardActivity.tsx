'use client';
// Message and en route entry points on cards and rows (F3; updates.html v7 "2 · My requests", "4 · Pending",
// #clarify 3 and 5, #edit 1–3). Self-contained slots: each reads the store itself, so the cards they sit in
// only place them.
//   My requests (every status): the en route row (In medical), the last-message preview (when there are
//   messages), then En route / Arrived (front of house, In medical) and Message with its unread count.
//   Pending → To check: the preview above the answers, and a 44 px Message button left of them.
//   Pending → Friend coming: the en route row, then Message | Reunited.
//   Desk tables: a count after the name. Pending's Friend coming tab and the nav's Pending: a dot.
import { Button, IconButton } from '@radix-ui/themes';
import { Check, MessageSquare } from 'lucide-react';
import { WalkIcon } from './WalkIcon';
import type { ReactNode } from 'react';
import type { RequestSummary } from '@/lib/api-types';
import { requestThreadFocus, useMessaging } from '@/lib/client/messages-hooks';
import { navigate } from '@/lib/client/nav';
import { usePending, useSession } from '@/lib/client/store-contract';
import { initials, isInMedical } from '@/lib/domain';
import { previewText, sideOfTeam, unreadOf } from '@/lib/messaging';
import { EnrouteRow, useEnrouteControl } from './Enroute';
import s from './messages.module.css';

/** Opens the request with its Messages in view and the field focused. */
export function openThread(id: string): void {
  requestThreadFocus(id);
  navigate({ r: id });
}

function who(row: RequestSummary): string {
  return initials(row.name) || 'this request';
}

/** Starts with the visible "Message" (WCAG 2.5.3), then who and how many unread. */
function messageLabel(row: RequestSummary): string {
  const n = unreadOf(row);
  return n > 0 ? `Message about ${who(row)}, ${n} unread` : `Message about ${who(row)}`;
}

/** "Message" with the unread count on its corner (full-width or half of a two-button row). */
export function MessageButton({ row }: { row: RequestSummary }) {
  const n = unreadOf(row);
  return (
    <Button
      size="3"
      variant="outline"
      color="gray"
      highContrast
      className={`${s.btn} ${s.btnQuiet} ${s.msgBtn}`}
      aria-label={messageLabel(row)}
      data-testid="message-button"
      onClick={() => openThread(row.id)}
    >
      <MessageSquare size={16} strokeWidth={1.75} aria-hidden />
      Message
      {n > 0 ? (
        <span className={s.badge} aria-hidden data-testid="unread-badge">
          {n}
        </span>
      ) : null}
    </Button>
  );
}

/** The 44 px Message button of a To check card. */
export function MessageIconButton({ row }: { row: RequestSummary }) {
  const n = unreadOf(row);
  return (
    <IconButton
      size="3"
      variant="outline"
      color="gray"
      highContrast
      className={s.iconBtn}
      aria-label={messageLabel(row)}
      data-testid="message-button"
      onClick={() => openThread(row.id)}
    >
      <MessageSquare size={18} strokeWidth={1.75} aria-hidden />
      {n > 0 ? (
        <span className={s.badge} aria-hidden data-testid="unread-badge">
          {n}
        </span>
      ) : null}
    </IconButton>
  );
}

/** "Rae C.: Any tattoos or marks?" (or "You: …"), one line with an ellipsis, a dot while unread. */
export function PreviewRow({ row }: { row: RequestSummary }) {
  const last = row.lastMessage;
  if (!last || !(row.messageCount ?? 0)) return null;
  const p = previewText(last);
  const unread = unreadOf(row) > 0;
  return (
    <div className={s.preview} data-testid="message-preview" aria-hidden>
      {unread ? <span className={s.udot} data-testid="preview-unread" /> : null}
      <span className={s.previewText}>
        <span className={s.previewWho}>{p.who}:</span> {p.text}
      </span>
    </div>
  );
}

function Slot({ children, mine }: { children: ReactNode; mine?: boolean }) {
  return <div className={mine ? `${s.cardSlot} ${s.mineSlot}` : s.cardSlot}>{children}</div>;
}

/**
 * My requests: en route row (In medical), preview, then [En route | Arrived] (front of house, In medical,
 * until the friend arrived) and [Message].
 */
export function MineActivity({ row }: { row: RequestSummary }) {
  const api = useMessaging();
  const session = useSession();
  const enroute = useEnrouteControl(row);
  if (!api) return null;
  const foh = sideOfTeam(session.team) === 'foh';
  const inMedical = isInMedical(row.status);
  const arrived = enroute.enroute?.state === 'arrived';
  const action = foh && inMedical && !arrived ? (
    enroute.mine ? (
      <Button size="3" variant="outline" color="gray" highContrast className={`${s.btn} ${s.btnQuiet}`} onClick={enroute.arrive} data-testid="arrived-button" aria-label={`Arrived with the friend of ${who(row)}`}>
        <Check size={16} strokeWidth={2} aria-hidden />
        Arrived
      </Button>
    ) : (
      <Button size="3" variant="outline" color="gray" highContrast className={`${s.btn} ${s.btnQuiet}`} onClick={enroute.openNew} data-testid="enroute-button" aria-label={`En route: bringing the friend of ${who(row)}`}>
        <WalkIcon size={16} strokeWidth={2} aria-hidden />
        En route
      </Button>
    )
  ) : null;
  return (
    <Slot mine>
      {inMedical ? (
        <EnrouteRow enroute={enroute.enroute} status={row.status} onEdit={enroute.mine ? enroute.openEdit : undefined} pressed={enroute.sheetOpen} />
      ) : null}
      <PreviewRow row={row} />
      <div className={s.cardBtns} data-count={action ? 2 : 1}>
        {action}
        <MessageButton row={row} />
      </div>
      {enroute.sheet}
    </Slot>
  );
}

/** Pending → To check: the preview above the answers (the Message button sits in the answers row). */
export function CheckPreview({ row }: { row: RequestSummary }) {
  const api = useMessaging();
  if (!api) return null;
  return <PreviewRow row={row} />;
}

/** Pending → Friend coming: the en route row (read-only unless it is mine). */
export function ComingEnroute({ row }: { row: RequestSummary }) {
  const api = useMessaging();
  const enroute = useEnrouteControl(row);
  if (!api) return null;
  return (
    <>
      {enroute.enroute && isInMedical(row.status) ? (
        <Slot>
          <EnrouteRow enroute={enroute.enroute} status={row.status} onEdit={enroute.mine ? enroute.openEdit : undefined} pressed={enroute.sheetOpen} />
        </Slot>
      ) : null}
      {enroute.sheet}
    </>
  );
}

/** True when the store has the messages engine (cards keep their old layout without it). */
export function useHasMessages(): boolean {
  return !!useMessaging();
}

/** " 2 unread messages." for a row's screen-reader sentence ('' when none). */
export function unreadSentence(row: RequestSummary): string {
  const n = unreadOf(row);
  return n === 0 ? '' : ` ${n} unread ${n === 1 ? 'message' : 'messages'}.`;
}

/** A count after a name in a desk table row (unread messages from others). */
export function UnreadBadge({ row }: { row: RequestSummary }) {
  const n = unreadOf(row);
  if (n === 0) return null;
  return (
    <span className={s.rowBadge} data-testid="row-unread" aria-hidden>
      {n}
    </span>
  );
}

/** A dot after a label while any of these rows has unread messages. */
export function UnreadDot({ rows, label }: { rows: readonly RequestSummary[]; label: string }) {
  if (!rows.some((r) => unreadOf(r) > 0)) return null;
  return <span className={s.navDot} role="img" aria-label={label} data-testid="unread-dot" />;
}

/** Pending's Friend coming tab: a dot while a Friend coming request has unread messages. */
export function FriendComingDot() {
  const { friendComing } = usePending();
  return <UnreadDot rows={friendComing} label="Unread messages" />;
}

/** The nav's Pending item: a dot while any Pending request has unread messages (`rail`: on the icon). */
export function PendingDot({ rail = false }: { rail?: boolean }) {
  const { friendComing, waiting } = usePending();
  if (![...friendComing, ...waiting].some((r) => unreadOf(r) > 0)) return null;
  return <span className={rail ? `${s.navDot} ${s.railDot}` : s.navDot} role="img" aria-label="Unread messages" data-testid="unread-dot" />;
}
