'use client';
// Message and en route entry points on cards and rows (F3; updates.html v7 "2 · My requests", "4 · Pending",
// #clarify 3 and 5, #edit 1–3). Self-contained slots: each reads the store itself, so the cards they sit in
// only place them.
//   My requests (every status): the en route row (In medical), the last-message preview (when there are
//   messages), then En route / Reunited (front of house, In medical) and Message with its unread count.
//   Pending → To check: the preview above the answers, and a 44 px Message button left of them.
//   Pending → Friend coming: the en route row, then Message | Reunited.
//   Desk tables: a count after the name (a click on it lands at the thread). Pending's Friend coming tab and
//   the nav's Pending: a dot.
//   The request page (R1, 2026-11-07): the preview as a button under the status block (ThreadPreview).
// The Message buttons, the desk badge and the request page's preview open the thread (lib/client/thread-jump).
import { Button, IconButton, VisuallyHidden } from '@radix-ui/themes';
import { Check, ChevronDown, MessageSquare } from 'lucide-react';
import { WalkIcon } from './WalkIcon';
import type { ReactNode } from 'react';
import type { RequestSummary } from '@/lib/api-types';
import { useMessaging } from '@/lib/client/messages-hooks';
import { navigate } from '@/lib/client/nav';
import { useEventTimezone, useNow, usePending, useSession } from '@/lib/client/store-contract';
import { openThread, requestThreadJump } from '@/lib/client/thread-jump';
import { STATUS, alertName, isInMedical } from '@/lib/domain';
import { formatCreatedTime } from '@/lib/format';
import { useStatusTap } from '@/components/list/hooks';
import { previewText, sideOfTeam, unreadOf } from '@/lib/messaging';
import type { DisplayStage } from '@/lib/stages';
import { StageChip } from '@/components/list/StageChips';
import { EnrouteFailed, EnrouteRow, useEnrouteControl } from './Enroute';
import s from './messages.module.css';

function who(row: RequestSummary): string {
  return alertName(row.name) || 'this request';
}

/**
 * Holds the visible text in order (WCAG 2.5.3): "Message" then the badge's count, so "Message 4" is in the
 * name: "Message, 4 unread messages about J.D." / "Message about J.D.".
 */
function messageLabel(row: RequestSummary): string {
  const n = unreadOf(row);
  if (n === 0) return `Message about ${who(row)}`;
  return `Message, ${n} unread ${n === 1 ? 'message' : 'messages'} about ${who(row)}`;
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
      {/* The space keeps "Message 4" apart in the text that label-in-name checks compare with the name. */}
      {n > 0 ? ' ' : null}
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
  const sentence = `Last message${unread ? ', unread' : ''}, from ${last.mine ? 'you' : p.who}: ${p.text}`;
  return (
    <div className={s.preview} data-testid="message-preview">
      {unread ? <span className={s.udot} data-testid="preview-unread" aria-hidden /> : null}
      <span className={s.previewText} aria-hidden>
        <span className={s.previewWho}>{p.who}:</span> {p.text}
      </span>
      <VisuallyHidden>{sentence}</VisuallyHidden>
    </div>
  );
}

/** "Any tattoos or marks?" stays as it is; "Bring 1 person" gets its full stop (the sentence goes on). */
const closed = (text: string) => (/[.?!…]$/.test(text) ? text : `${text}.`);

/**
 * (Request page order R1, Brian 2026-11-07) The request page's latest-message line, under the status block: the
 * cards' preview ("Rae C.: Any tattoos or marks?", the unread dot) as one 44 px button that brings the thread into
 * view, and on a computer focuses the composer. The page decides when it shows (lib/messaging threadPreviewShown).
 * (2026-11-08, T1 + T2) Up to two lines (three under 360 px) with the message's time at the right ("12:24 PM"), and
 * the page passes no Needs info chip (its status block says it). `needsInfo` still puts the chip first if passed.
 */
export function ThreadPreview({ row, needsInfo, unread }: { row: RequestSummary; needsInfo: DisplayStage | null; unread: boolean }) {
  const now = useNow();
  const timeZone = useEventTimezone();
  const last = row.lastMessage && (row.messageCount ?? 0) > 0 ? row.lastMessage : null;
  const p = last ? previewText(last) : null;
  const at = last && row.lastMessageAt && Number.isFinite(Date.parse(row.lastMessageAt)) ? formatCreatedTime(row.lastMessageAt, now, timeZone) : null;
  const said = [
    needsInfo ? `${needsInfo.label}.` : '',
    last && p ? closed(`Last message${unread ? ', unread' : ''}, from ${last.mine ? 'you' : p.who}${at ? ` at ${at}` : ''}: ${p.text}`) : '',
    'Go to messages.',
  ];
  return (
    <button type="button" className={s.threadPreview} data-testid="thread-preview" onClick={() => requestThreadJump(row.id)}>
      {needsInfo ? (
        <span className={s.tpChip} aria-hidden>
          <StageChip stage={needsInfo} />
        </span>
      ) : null}
      <span className={`${s.preview} ${s.tpBox}`} aria-hidden>
        {unread ? <span className={s.udot} data-testid="preview-unread" /> : null}
        {p ? (
          <span className={s.previewText}>
            <span className={s.previewWho}>{p.who}:</span> {p.text}
          </span>
        ) : null}
        {at ? (
          <span className={s.tpTime} data-testid="preview-time">
            {at}
          </span>
        ) : null}
        <ChevronDown size={16} strokeWidth={2} className={s.tpGo} />
      </span>
      <VisuallyHidden>{said.filter(Boolean).join(' ')}</VisuallyHidden>
    </button>
  );
}

function Slot({ children, mine }: { children: ReactNode; mine?: boolean }) {
  return <div className={mine ? `${s.cardSlot} ${s.mineSlot}` : s.cardSlot}>{children}</div>;
}

/**
 * My requests: en route row (In medical), preview, then [En route | Reunited] (front of house, In medical) and
 * [Message]. (2026-11-08, Arrived dropped: design/DECISIONS.md "Request page tonight") Once I am en route, or the
 * friend arrived on an old row, the card offers the request's Reunited instead: the same tap as Pending's Friend
 * coming card (useStatusTap → setStatus reunite, with its Undo; "Needs a connection" offline).
 */
export function MineActivity({ row }: { row: RequestSummary }) {
  const api = useMessaging();
  const session = useSession();
  const enroute = useEnrouteControl(row);
  const { offline, tap } = useStatusTap();
  if (!api) return null;
  const foh = sideOfTeam(session.team) === 'foh';
  const inMedical = isInMedical(row.status);
  const arrived = enroute.enroute?.state === 'arrived';
  const action = foh && inMedical ? (
    enroute.mine || arrived ? (
      <Button
        size="3"
        highContrast
        className={s.btn}
        {...(offline ? { 'aria-disabled': true, 'data-disabled': '' } : {})}
        onClick={() => void tap(row.id, STATUS.reunited, 'reunite')}
        data-testid="reunited-button"
        aria-label={`Reunited: ${who(row)}`}
      >
        <Check size={16} strokeWidth={2.25} aria-hidden />
        Reunited
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
      <EnrouteFailed control={enroute} />
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
      {(enroute.enroute && isInMedical(row.status)) || enroute.failed ? (
        <Slot>
          {enroute.enroute && isInMedical(row.status) ? (
            <EnrouteRow enroute={enroute.enroute} status={row.status} onEdit={enroute.mine ? enroute.openEdit : undefined} pressed={enroute.sheetOpen} />
          ) : null}
          <EnrouteFailed control={enroute} />
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

/** A desk row's unread badge marks itself: a click on it opens the request at its Messages (openRowAt). */
const THREAD_BADGE = 'data-thread-badge';

/**
 * A count after a name in a desk table row (unread messages from others). The row is the one control (a button
 * holds no other); a click on the badge (its tap area grown to 44 px) lands at the thread (R2).
 */
export function UnreadBadge({ row }: { row: RequestSummary }) {
  const n = unreadOf(row);
  if (n === 0) return null;
  return (
    <span className={s.rowBadge} data-testid="row-unread" {...{ [THREAD_BADGE]: '' }} aria-hidden>
      {n}
    </span>
  );
}

/** A desk row's click: at the Messages when it landed on the unread badge, else at the top. */
export function openRowAt(id: string, target: EventTarget | null): void {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (typeof el?.closest === 'function' && el.closest(`[${THREAD_BADGE}]`)) openThread(id);
  else navigate({ r: id });
}

/** A dot after a label while any of these rows has unread messages. */
export function UnreadDot({ rows, label }: { rows: readonly RequestSummary[]; label: string }) {
  if (!rows.some((r) => unreadOf(r) > 0)) return null;
  return <span className={s.navDot} role="img" aria-label={label} data-testid="unread-dot" />;
}

/** The nav's Pending item: a dot while any Pending request has unread messages (`rail`: on the icon). */
export function PendingDot({ rail = false }: { rail?: boolean }) {
  const { friendComing, waiting } = usePending();
  if (![...friendComing, ...waiting].some((r) => unreadOf(r) > 0)) return null;
  return <span className={rail ? `${s.navDot} ${s.railDot}` : s.navDot} role="img" aria-label="Unread messages" data-testid="unread-dot" />;
}
