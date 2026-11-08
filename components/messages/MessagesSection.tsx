'use client';
// Messages on a request (F3; design/screens/updates.html v7 "1 · Messages on the request", #clarify 6–7,
// f34-states.html 6). A chat thread that belongs to the request, at every status: bubbles only (no system
// lines, no timestamps), iMessage grouping with "Name · Team" above the first bubble of someone else's run,
// and under MY latest message "Delivered" or "Read 4:14 PM" in words. Queued bubbles are dimmed with
// "Sending…"; failed ones say "Not delivered · Retry". Long-press (or right-click, or the ⋯ on a desktop)
// gives Copy, and Unsend for my own within 15 minutes. Plain text only.
//
// (R1, Brian 2026-11-07) It sits below the request's details and photos. A jump (R2: a Message button, a desk
// row's unread badge, a message's Activity row, toast or notification, the page's own preview line) brings it
// into view at its newest message, and focuses the composer on a computer only.
//
// The thread scrolls in its own box and opens at the newest message; "New messages" shows when new ones
// arrive while it is scrolled up; screen readers hear new incoming messages (polite). The composer is one
// rounded field with the send arrow inside it and the quick lines for this status and side above it. A message
// quick line fills the field (appended after a space to anything typed), and nothing is posted until Send
// (Brian 2026-11-07 13:55); En route opens its sheet and Arrived acts at once, as before.
import { Button, ContextMenu, DropdownMenu, IconButton, Skeleton, TextArea, VisuallyHidden } from '@radix-ui/themes';
import { ArrowDown, ArrowUp, Check, CloudOff, Copy, Ellipsis, MessageCircle, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { WalkIcon } from './WalkIcon';
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal, flushSync } from 'react-dom';
import type { RequestSummary } from '@/lib/api-types';
import { meFor } from '@/lib/client/messages-core';
import { useMessaging, useOpenThread, useRequestJobs, useThread } from '@/lib/client/messages-hooks';
import { buildBubbles, receiptFor, type Bubble } from '@/lib/client/messages-logic';
import { useActions, useEventTimezone, useNow, useSession } from '@/lib/client/store-contract';
import { formatCreatedTime } from '@/lib/format';
import { MESSAGE_COUNTER_FROM, MESSAGE_MAX, UNSEND_WINDOW_MS, fillWithQuickLine, messageLength, quickLines, quickStage, sideOfTeam } from '@/lib/messaging';
import { dropOtherThreadJump, subscribeThreadJump, takeThreadJump, threadJumpWaiting } from '@/lib/client/thread-jump';
import { DESK_QUERY } from '@/components/desk/breakpoints';
import { useEnrouteControl } from './Enroute';
import s from './messages.module.css';

export interface MessagesSectionProps {
  row: RequestSummary;
  /** In the desk pane (the quick lines wrap instead of scrolling sideways). */
  panel?: boolean;
}

const AT_BOTTOM_PX = 32;
const FINE_POINTER = '(hover: hover) and (pointer: fine)';
/** (R2) A jump focuses the composer here only: the desk layout with a mouse or trackpad. */
const COMPUTER = `${DESK_QUERY} and ${FINE_POINTER}`;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

export function MessagesSection({ row, panel = false }: MessagesSectionProps) {
  const api = useMessaging();
  if (!api) return null;
  return <Section row={row} panel={panel} />;
}

function Section({ row, panel }: { row: RequestSummary; panel: boolean }) {
  const api = useMessaging();
  const actions = useActions();
  const session = useSession();
  const timeZone = useEventTimezone();
  const now = useNow();
  const headingId = useId();
  useOpenThread(row.id);
  const thread = useThread(row.id);
  const jobs = useRequestJobs(row.id);
  const me = useMemo(() => meFor(session.staff), [session.staff]);
  const messages = useMemo(() => thread?.messages ?? [], [thread?.messages]);
  const bubbles = useMemo(() => buildBubbles(messages, jobs, me), [messages, jobs, me]);
  const receipt = receiptFor(messages, thread?.receipt ?? null);
  const enroute = useEnrouteControl(row);

  // --- scrolling: open at the newest; "New messages" when new ones arrive while scrolled up ------------
  const scroller = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const live = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastKey = useRef<string | null>(null);
  const firstShown = useRef(false);
  const [newPill, setNewPill] = useState(false);

  const scrollToEnd = useCallback((smooth: boolean) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atBottom.current = true;
  }, []);
  const toBottom = useCallback(() => {
    scrollToEnd(true);
    setNewPill(false);
  }, [scrollToEnd]);

  useLayoutEffect(() => {
    const last = bubbles[bubbles.length - 1];
    const key = last?.key ?? null;
    if (key === lastKey.current) return;
    const previous = lastKey.current;
    lastKey.current = key;
    if (!last) return;
    if (!firstShown.current) {
      firstShown.current = true;
      scrollToEnd(false);
      return;
    }
    // Only a new message at the end counts (an older page loaded above changes nothing here).
    if (previous && bubbles.findIndex((b) => b.key === previous) === bubbles.length - 1) return;
    // Screen readers hear a new incoming message (the live region is written directly, like the scroll).
    if (!last.mine && last.message && live.current) live.current.textContent = `${last.by}: ${last.body}`;
    if (last.mine || atBottom.current) {
      scrollToEnd(true);
      return;
    }
    const frame = requestAnimationFrame(() => setNewPill(true));
    return () => cancelAnimationFrame(frame);
  }, [bubbles, scrollToEnd]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
    if (atBottom.current) setNewPill(false);
  };

  // --- read: the thread on screen marks itself read up to its newest message ---------------------------
  const unread = row.unread ?? 0;
  useEffect(() => {
    if (thread?.status === 'ready') api?.markRead(row.id);
  }, [api, row.id, thread?.status, messages, unread]);

  // --- refresh when the synced row says the thread changed ---------------------------------------------
  const lastAt = row.lastMessageAt ?? null;
  const count = row.messageCount ?? 0;
  const seenActivity = useRef<string | null>(null);
  useEffect(() => {
    const key = `${lastAt}|${count}`;
    if (seenActivity.current === null) {
      seenActivity.current = key;
      return;
    }
    if (seenActivity.current === key) return;
    seenActivity.current = key;
    api?.refresh(row.id);
  }, [api, row.id, lastAt, count]);

  // --- (R2) a jump to the thread (lib/client/thread-jump): into view, at its newest; the composer focused on a
  // computer only (a phone keeps its keyboard down: the heading takes the focus) --------------------------
  useEffect(() => {
    const id = row.id;
    let frame = 0;
    let release = () => {};
    const land = () => {
      if (!threadJumpWaiting(id) || frame) return;
      // After this commit's other effects (the page and the desk pane start a request at its top).
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!takeThreadJump(id)) return;
        release();
        if (section.current) {
          scrollToSection(section.current, window.matchMedia(REDUCED_MOTION).matches ? 'auto' : 'smooth');
          release = holdLanding(section.current);
        }
        scrollToEnd(false);
        setNewPill(false);
        if (window.matchMedia(COMPUTER).matches) input.current?.focus({ preventScroll: true });
        else heading.current?.focus({ preventScroll: true });
      });
    };
    dropOtherThreadJump(id);
    land();
    const off = subscribeThreadJump(land);
    return () => {
      off();
      cancelAnimationFrame(frame);
      release();
    };
  }, [row.id, scrollToEnd]);

  const side = sideOfTeam(session.team);
  const lines = quickLines(quickStage(row), side, enroute.mine, enroute.enroute?.state === 'arrived');

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => actions.showToast({ tone: 'neutral', icon: 'check', title: 'Copied', durationMs: 2_000 }),
      () => undefined,
    );
  };

  const loading = !thread || (thread.loadedAt === 0 && thread.messages.length === 0 && thread.status === 'loading');
  const failed = !!thread && thread.status === 'error' && thread.messages.length === 0;

  return (
    <section ref={section} className={panel ? `${s.section} ${s.panel}` : s.section} aria-labelledby={headingId} data-testid="messages">
      <h2 className={s.head} id={headingId} ref={heading} tabIndex={-1}>
        Messages
      </h2>
      <div className={s.scroller} ref={scroller} onScroll={onScroll} data-testid="thread">
        {thread?.hasEarlier ? (
          <Button
            variant="ghost"
            color="gray"
            size="2"
            className={`${s.earlier} lp-hit`}
            loading={thread.loadingEarlier}
            onClick={() => void api?.loadEarlier(row.id)}
          >
            Earlier messages
          </Button>
        ) : null}
        {loading && bubbles.length === 0 ? (
          <div className={s.skeleton} role="status" aria-busy="true" aria-label="Loading messages">
            <Skeleton width="55%" height="36px" style={{ borderRadius: 19 }} />
            <Skeleton width="40%" height="36px" style={{ borderRadius: 19, alignSelf: 'flex-end' }} />
          </div>
        ) : failed && bubbles.length === 0 ? (
          <div className={s.loadFail}>
            <CloudOff size={18} aria-hidden />
            <Button size="2" variant="soft" color="gray" className="lp-hit" onClick={() => api?.refresh(row.id)} aria-label="Messages could not load. Try again.">
              Try again
            </Button>
          </div>
        ) : bubbles.length === 0 ? (
          <div className={s.empty} role="img" aria-label="No messages yet" data-testid="thread-empty">
            <MessageCircle size={30} strokeWidth={1.5} aria-hidden />
          </div>
        ) : (
          <div className={s.chat} role="log" aria-label="Messages">
            {bubbles.map((b, i) => (
              <Fragment key={b.key}>
                {b.runStart && i > 0 ? <div className={s.gap} aria-hidden /> : null}
                {b.runStart && !b.mine ? (
                  <span className={s.from} aria-hidden>
                    <b>{b.by}</b>
                    {b.team ? ` · ${b.team}` : ''}
                  </span>
                ) : null}
                <BubbleRow
                  bubble={b}
                  now={now}
                  onCopy={() => copy(b.body)}
                  onUnsend={b.message && b.mine ? () => void api?.unsend(row.id, b.message!.id) : null}
                  onRetry={b.jobId ? () => api?.retry(b.jobId!) : null}
                  onDelete={b.jobId && b.pending === 'failed' ? () => void api?.discard(b.jobId!) : null}
                />
                {b.pending === 'sending' ? (
                  <span className={s.receipt} data-testid="receipt-sending">
                    Sending…
                  </span>
                ) : b.pending === 'failed' ? (
                  <span className={`${s.receipt} ${s.failed}`} data-testid="receipt-failed">
                    <b>Not delivered</b> ·
                    <button type="button" className={s.retry} onClick={() => b.jobId && api?.retry(b.jobId)}>
                      Retry
                    </button>
                  </span>
                ) : receipt && b.message?.id === receipt.messageId ? (
                  <span className={s.receipt} data-testid="receipt">
                    {receipt.readAt ? (
                      <>
                        <b>Read</b> {formatCreatedTime(receipt.readAt, now, timeZone)}
                      </>
                    ) : (
                      'Delivered'
                    )}
                  </span>
                ) : null}
              </Fragment>
            ))}
          </div>
        )}
        {newPill ? (
          <button type="button" className={s.newPill} onClick={toBottom} data-testid="new-messages">
            <ArrowDown size={15} strokeWidth={2.25} aria-hidden />
            New messages
          </button>
        ) : null}
      </div>
      {/* At the end of <body>, not in the request: a live region inside it would make a modal menu's
          aria-hidden split the request into pieces (aria-hidden keeps live regions readable). */}
      {typeof document === 'undefined'
        ? null
        : createPortal(
            <VisuallyHidden>
              <div ref={live} aria-live="polite" aria-atomic="true" data-testid="thread-live" />
            </VisuallyHidden>,
            document.body,
          )}

      <Composer
        lines={lines}
        inputRef={input}
        onSendText={async (text) => {
          const ok = (await api?.send(row.id, text)) ?? false;
          if (ok) toBottom();
          return ok;
        }}
        onEnroute={enroute.openNew}
        onArrived={enroute.arrive}
      />
      {enroute.sheet}
    </section>
  );
}

/** The request's own scroller: the desk pane's body, or null for the page. */
function scrollBoxOf(el: HTMLElement): HTMLElement | null {
  for (let box = el.parentElement; box && box !== document.body && box !== document.documentElement; box = box.parentElement) {
    const overflow = getComputedStyle(box).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return box;
  }
  return null;
}

/** Space kept between the composer and the phone's action bar (or the pane's bottom edge). */
const COMPOSER_GAP = 8;

/**
 * (R2, design/screens/msg-indicator-5.png) Where a jump lands, as the scroller's scrollTop: the section's top under its
 * scroll-margin (the Messages heading right under the phone's top bar, 4 px into the desk pane). Where the screen is
 * too short for the whole section, a little further, so the composer still clears the phone's action bar (stuck to
 * the foot of the screen, ProfileView's [data-sticky-foot]) or the pane's bottom edge: the newest messages sit right
 * above it.
 */
function landingTop(el: HTMLElement, box: HTMLElement | null): number {
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  const frame = box ? box.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const foot = (box ?? document).querySelector<HTMLElement>('[data-sticky-foot]');
  const visibleBottom = frame.bottom - (foot ? foot.offsetHeight : 0);
  const rect = el.getBoundingClientRect();
  const head = rect.top - frame.top - margin;
  const fit = rect.bottom + COMPOSER_GAP - visibleBottom;
  return (box ? box.scrollTop : window.scrollY) + Math.max(head, fit);
}

/**
 * (R2) Scrolls the request's own scroller (the desk pane's body, else the page) so the section lands (landingTop).
 * Not scrollIntoView: that moves every scroller around it, the desk's list included.
 */
function scrollToSection(el: HTMLElement, behavior: ScrollBehavior): void {
  const box = scrollBoxOf(el);
  const to = { top: landingTop(el, box), behavior };
  if (box) box.scrollTo(to);
  else window.scrollTo(to);
}

/** How long a jump keeps its landing while the request settles. */
const HOLD_MS = 5_000;
/** A jump's smooth scroll has ended by now (or stopped short: WebKit stops one when the page grows under it). */
const SETTLE_MS = 900;
const HAND_BACK = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * (R2) Holds a jump's landing while the request settles. What shows after the jump (the thread replacing its
 * skeleton, the request's details, a photo) changes the height around the section, so a scroll aimed before that
 * stops short (the page could not yet scroll that far) or lands off. Until the person scrolls, taps or types, or
 * HOLD_MS pass, every change of the layout aims it again, without animation, as does the end of the smooth scroll.
 * A scroll from anywhere else (the status bar, a scrollbar, a script) hands it back too. Call it right after the
 * jump's scrollToSection. Returns the release.
 */
function holdLanding(el: HTMLElement): () => void {
  const box = scrollBoxOf(el);
  const at = () => (box ? box.scrollTop : window.scrollY);
  // The smooth scroll's goal, and where it has got to: it only ever closes in on the goal.
  const goal = landingTop(el, box);
  let last = at();
  // Where the section sits in what scrolls, and how tall that is: both stay put while it scrolls.
  const layout = () => {
    const top = el.getBoundingClientRect().top - (box ? box.getBoundingClientRect().top : 0) + at();
    return `${Math.round(top)}|${Math.round(el.offsetHeight)}|${box ? box.scrollHeight : document.documentElement.scrollHeight}`;
  };
  let seen = layout();
  /** Where the last aim left the scroller; null while the jump's smooth scroll runs. */
  let aimed: number | null = null;
  let done = false;
  const aim = () => {
    if (done || !el.isConnected) return;
    seen = layout();
    scrollToSection(el, 'auto');
    aimed = at();
  };
  const moved = () => {
    if (done || layout() === seen) return false;
    aim();
    return true;
  };
  const onScroll = () => {
    if (done || moved()) return;
    const now = at();
    if (aimed === null) {
      if (Math.abs(now - goal) > Math.abs(last - goal) + 2) release();
      else last = now;
    } else if (Math.abs(now - aimed) > 2) release();
  };
  const settle = () => {
    if (aimed === null) aim();
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => void moved());
  for (let node: HTMLElement | null = el; node && node !== box && node !== document.body; node = node.parentElement) observer?.observe(node);
  const scroller: EventTarget = box ?? window;
  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('scrollend', settle);
  for (const type of HAND_BACK) window.addEventListener(type, release, { capture: true, passive: true });
  const settleTimer = window.setTimeout(settle, SETTLE_MS);
  const holdTimer = window.setTimeout(release, HOLD_MS);
  function release() {
    if (done) return;
    done = true;
    observer?.disconnect();
    scroller.removeEventListener('scroll', onScroll);
    scroller.removeEventListener('scrollend', settle);
    for (const type of HAND_BACK) window.removeEventListener(type, release, { capture: true });
    window.clearTimeout(settleTimer);
    window.clearTimeout(holdTimer);
  }
  return release;
}

// ---------------------------------------------------------------------------------------------------
// One bubble, with its menu
// ---------------------------------------------------------------------------------------------------

interface MenuItem {
  key: string;
  label: string;
  icon: typeof Copy;
  danger?: boolean;
  run: () => void;
}

function BubbleRow({
  bubble,
  now,
  onCopy,
  onUnsend,
  onRetry,
  onDelete,
}: {
  bubble: Bubble;
  now: number;
  onCopy: () => void;
  onUnsend: (() => void) | null;
  onRetry: (() => void) | null;
  onDelete: (() => void) | null;
}) {
  const items: MenuItem[] = [{ key: 'copy', label: 'Copy', icon: Copy, run: onCopy }];
  const canUnsend = !!onUnsend && !!bubble.message && Date.parse(bubble.message.createdAt) + UNSEND_WINDOW_MS > now;
  if (canUnsend && onUnsend) items.push({ key: 'unsend', label: 'Unsend', icon: Undo2, danger: true, run: onUnsend });
  if (bubble.pending === 'failed' && onRetry) items.push({ key: 'retry', label: 'Retry', icon: RotateCcw, run: onRetry });
  if (onDelete) items.push({ key: 'delete', label: 'Delete', icon: Trash2, danger: true, run: onDelete });
  const run = bubble.runStart && bubble.runEnd ? 'single' : bubble.runStart ? 'start' : bubble.runEnd ? 'end' : 'mid';
  const who = bubble.mine ? 'You' : `${bubble.by}${bubble.team ? `, ${bubble.team}` : ''}`;
  const state = bubble.pending === 'sending' ? ' Sending.' : bubble.pending === 'failed' ? ' Not delivered.' : '';
  const more = (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <IconButton size="1" variant="ghost" color="gray" radius="full" className={`${s.more} lp-hit`} aria-label={`Message options: ${bubble.body.slice(0, 40)}`}>
          <Ellipsis size={16} aria-hidden />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content variant="soft" align={bubble.mine ? 'end' : 'start'}>
        {items.map((it) => (
          <DropdownMenu.Item key={it.key} color={it.danger ? 'red' : undefined} onSelect={it.run}>
            {it.label}
            <it.icon size={16} aria-hidden style={{ marginLeft: 'auto' }} />
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
  return (
    <div className={s.row} data-mine={bubble.mine ? '' : undefined}>
      {bubble.mine ? more : null}
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          <div
            className={`${s.bubble} ${bubble.mine ? s.mine : s.them}`}
            data-run={run}
            data-pending={bubble.pending ? '' : undefined}
            data-testid={bubble.mine ? 'bubble-mine' : 'bubble-them'}
            role="article"
            tabIndex={0}
            aria-label={`${who}: ${bubble.body}.${state}`}
          >
            {bubble.body}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Content variant="soft">
          {items.map((it) => (
            <ContextMenu.Item key={it.key} color={it.danger ? 'red' : undefined} onSelect={it.run}>
              {it.label}
              <it.icon size={16} aria-hidden style={{ marginLeft: 'auto' }} />
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Root>
      {bubble.mine ? null : more}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Composer: quick lines, then one rounded field with the send arrow inside it
// ---------------------------------------------------------------------------------------------------

function Composer({
  lines,
  inputRef,
  onSendText,
  onEnroute,
  onArrived,
}: {
  lines: ReturnType<typeof quickLines>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onSendText: (text: string) => Promise<boolean>;
  onEnroute: () => void;
  onArrived: () => void;
}) {
  const [value, setValue] = useState('');
  const counterId = useId();
  const length = messageLength(value);
  const showCounter = length >= MESSAGE_COUNTER_FROM;
  const ready = length > 0 && length <= MESSAGE_MAX;

  const fit = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [inputRef]);
  useLayoutEffect(fit, [value, fit]);

  // A message quick line puts its words in the field (fillWithQuickLine: never replacing what is typed). The field
  // takes focus with the caret at the end and the send arrow goes live; nothing is posted until Send.
  const fill = (text: string) => {
    const next = fillWithQuickLine(value, text);
    flushSync(() => setValue(next));
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(next.length, next.length);
  };

  const send = async () => {
    if (!ready) return;
    const text = value;
    setValue('');
    const ok = await onSendText(text);
    if (!ok) setValue(text);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // A desktop sends on Enter (Shift+Enter is a new line); a phone's return key makes a new line.
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    if (typeof window === 'undefined' || !window.matchMedia(FINE_POINTER).matches) return;
    e.preventDefault();
    void send();
  };

  return (
    <div className={s.composer} data-testid="composer">
      {lines.length > 0 ? (
        <div className={s.pills} role="group" aria-label="Quick messages" data-testid="quick-lines">
          {lines.map((l) => (
            <button
              key={l.text}
              type="button"
              className={s.pill}
              data-kind={l.kind}
              onClick={() => {
                if (l.kind === 'enroute') onEnroute();
                else if (l.kind === 'arrived') onArrived();
                else fill(l.text);
              }}
              aria-label={l.kind === 'message' ? `Add to message: ${l.text}` : l.kind === 'enroute' ? 'En route: bringing the friend' : 'Arrived with the friend'}
            >
              {l.kind === 'enroute' ? <WalkIcon size={15} strokeWidth={2} aria-hidden /> : null}
              {l.kind === 'arrived' ? <Check size={15} strokeWidth={2} aria-hidden /> : null}
              {l.text}
            </button>
          ))}
        </div>
      ) : null}
      <div className={s.field}>
        <TextArea
          ref={inputRef}
          size="3"
          variant="surface"
          radius="full"
          className={s.input}
          rows={1}
          value={value}
          maxLength={MESSAGE_MAX}
          placeholder="Message"
          aria-label="Message"
          aria-describedby={showCounter ? counterId : undefined}
          onChange={(e) => setValue(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          data-testid="composer-input"
        />
        <IconButton
          size="2"
          radius="full"
          variant={ready ? 'solid' : 'soft'}
          color="gray"
          className={s.send}
          data-ready={ready ? '' : undefined}
          disabled={!ready}
          aria-label="Send message"
          onClick={() => void send()}
          data-testid="composer-send"
        >
          <ArrowUp size={17} strokeWidth={2.5} aria-hidden />
        </IconButton>
      </div>
      {showCounter ? (
        <span className={s.counter} id={counterId} data-over={length > MESSAGE_MAX ? '' : undefined}>
          {length} / {MESSAGE_MAX}
          <VisuallyHidden> characters</VisuallyHidden>
        </span>
      ) : null}
    </div>
  );
}
