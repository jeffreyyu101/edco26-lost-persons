'use client';
// Messages on a request (F3; design/screens/updates.html v7 "1 · Messages on the request", #clarify 6–7,
// f34-states.html 6). A chat thread that belongs to the request, at every status: bubbles only (no system
// lines), iMessage grouping with "Name · Team · 12:14 PM" above the first bubble of someone else's run and the
// time alone at the right over my own (2026-11-08, T5: reverses F3's "no timestamps"; a run also breaks after
// 5 minutes, messages-logic buildBubbles), and under MY latest message "Delivered" or "Read 4:14 PM" in words.
// Queued bubbles are dimmed with "Sending…"; failed ones say "Not delivered · Retry". Long-press (or right-click,
// or the ⋯ on a desktop) gives Copy, and Unsend for my own within 15 minutes. Plain text only.
//
// (R1, Brian 2026-11-07) It sits below the request's details and photos. A jump (R2: a Message button, a row's
// message lane, a message's Activity row, toast or notification, the page's own preview line) brings it
// into view at its newest message, and focuses the composer on a computer only. It lands as the message lane's
// frame 5 (design/screens/msg-indicator-5.png), held there while the request settles (holdLanding).
//
// (2026-11-08) On a phone the thread is part of the page, not a box of its own: a swipe anywhere on it scrolls the
// page, the newest message is at the bottom, and the page follows a new message while the reader is at the thread's
// end ("New messages" while they read higher up). "Earlier messages" keeps the message on screen where it was. The
// desk pane keeps the thread's own scroller (it opens at the newest message) with its overscroll contained. Screen
// readers hear new incoming messages (polite). The composer is one rounded field with the send arrow inside it and
// the quick lines for this status and side above it (they wrap).
// A message quick line fills the field (appended after a space to anything typed), and nothing is posted until
// Send (Brian 2026-11-07 13:55); En route opens its sheet. (2026-11-08) There is no Arrived quick line any more.
import { Button, ContextMenu, DropdownMenu, IconButton, Skeleton, TextArea, VisuallyHidden } from '@radix-ui/themes';
import { ArrowDown, ArrowUp, CloudOff, Copy, Ellipsis, MessageCircle, RotateCcw, Trash2, Undo2 } from 'lucide-react';
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
import { keyboardBox } from '@/lib/client/visual-viewport';
import { DESK_QUERY } from '@/components/desk/breakpoints';
import { useEnrouteControl } from './Enroute';
import s from './messages.module.css';

export interface MessagesSectionProps {
  row: RequestSummary;
  /**
   * In the desk pane (the thread scrolls in its own box, and a jump lands under the pane's top). Else the phone's
   * page: the thread is part of the page and scrolls with it.
   */
  panel?: boolean;
}

const AT_BOTTOM_PX = 32;
/** (2026-11-08) After the phone's page is scrolled to the thread's end, its scroll events don't count for this long. */
const OWN_SCROLL_MS = 900;
/** The desk pane's "New messages" pill sits this far above the bottom of the thread (a phone's: KEEP_GAP_PX above the bar). */
const PILL_GAP_PX = 8;
const FINE_POINTER = '(hover: hover) and (pointer: fine)';
/** (R2) A jump focuses the composer here only: the desk layout with a mouse or trackpad. */
const COMPUTER = `${DESK_QUERY} and ${FINE_POINTER}`;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
/**
 * The reader's own input (they are moving the page themselves): it hands back a jump's hold on its landing
 * (holdLanding), and (2026-11-08) ends a phone's wait for a thread that had not shown yet when its jump landed (it
 * lands again when it shows, however long that takes, unless one of these comes first).
 */
const READER_INPUT = ['touchstart', 'pointerdown', 'wheel', 'keydown'] as const;
/**
 * Room a jump keeps under the composer: on a phone between the message field and the request's sticky action bar (or
 * the keyboard), in the desk pane between the section's end and the pane's bottom edge.
 */
const KEEP_GAP_PX = 8;

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

  // --- scrolling: the newest at the bottom; "New messages" when new ones arrive while the reader is higher up ---
  // The desk pane's thread is its own scroller. (2026-11-08) On a phone the thread is part of the page: "at the
  // bottom" is its end on screen above the sticky action bar, and the scroll to the end is the page's.
  const box = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const live = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastKey = useRef<string | null>(null);
  const firstShown = useRef(false);
  /** A phone's jump landed while the thread was loading: it lands again once the thread shows (until the reader's input). */
  const settle = useRef(false);
  /** Ends `settle` and stops listening for the reader's input. */
  const unsettle = useRef<() => void>(() => undefined);
  /** Releases the latest jump's hold on its landing (holdLanding). */
  const holding = useRef<() => void>(() => undefined);
  /** (Phone) Until when the page's scroll events are this thread's own scroll to its end (they keep atBottom). */
  const ownScroll = useRef(0);
  /**
   * "Earlier messages": the first bubble and its top (bubbleTop), from the tap until older ones show above it (then it is
   * kept there). The top follows the reader's own scrolling meanwhile.
   */
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const loadingEarlier = thread?.loadingEarlier === true;
  const wasLoadingEarlier = useRef(false);
  /** "New messages" (null: hidden), with its distance from the bottom of the thread's scrollport (px). */
  const [newPill, setNewPill] = useState<number | null>(null);

  const scrollToEnd = useCallback(
    (smooth: boolean) => {
      atBottom.current = true;
      if (panel) {
        const el = box.current;
        el?.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
        return;
      }
      // The phone: the page, so the message field (under the newest message) ends above the action bar. Never up.
      const sec = section.current;
      const field = input.current;
      if (!sec || !field) return;
      const by = field.getBoundingClientRect().bottom - pageView(sec).bottom;
      if (by <= 0) return;
      ownScroll.current = Date.now() + OWN_SCROLL_MS;
      window.scrollTo({ top: window.scrollY + by, behavior: smooth ? motion() : 'auto' });
    },
    [panel],
  );
  const toBottom = useCallback(() => {
    scrollToEnd(true);
    setNewPill(null);
  }, [scrollToEnd]);

  /**
   * (R2) Lands the section where a jump lands (landingTop: on a phone with the message field above the action bar) and
   * holds it there while the request settles (holdLanding), in place of any earlier hold.
   */
  const landSection = useCallback(
    (behavior: ScrollBehavior) => {
      holding.current();
      holding.current = () => undefined;
      const el = section.current;
      if (!el) return;
      const keep = panel ? null : input.current;
      scrollToSection(el, behavior, keep);
      holding.current = holdLanding(el, keep);
    },
    [panel],
  );

  /** Whether the thread's end is on screen (the pane: its scroller at its end; the phone: above the action bar). */
  const measureAtBottom = useCallback((): boolean => {
    const el = box.current;
    if (!el) return true;
    if (panel) return el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
    const end = el.getBoundingClientRect().bottom;
    const view = pageView(el);
    return end >= view.top && end <= view.bottom + AT_BOTTOM_PX;
  }, [panel]);

  /** Where the reader wants the pill (its sticky `bottom`): the pane's 8 px, a phone's just above the bar or keyboard. */
  const pillLift = useCallback((): number => {
    const sec = section.current;
    return panel || !sec ? PILL_GAP_PX : window.innerHeight - pageView(sec).bottom;
  }, [panel]);

  useLayoutEffect(() => {
    // "Earlier messages": the bubble that was first on screen stays where it was (no jump), on the page as in the pane.
    // Only the older page going in above it moves anything; any other render keeps its place as it is now.
    const held = anchor.current;
    if (held) {
      const top = bubbleTop(box.current, held.key, panel);
      if (bubbles[0]?.key !== held.key) {
        const by = top === null ? 0 : top - held.top;
        if (Math.abs(by) >= 1) {
          if (panel) box.current?.scrollBy({ top: by });
          else window.scrollBy({ top: by });
        }
        anchor.current = null;
      } else if (wasLoadingEarlier.current && !loadingEarlier) {
        // The load ended with nothing new (it failed): nothing to keep.
        anchor.current = null;
      } else if (top !== null) held.top = top;
    }
    wasLoadingEarlier.current = loadingEarlier;
  }, [bubbles, loadingEarlier, panel]);

  useLayoutEffect(() => {
    const last = bubbles[bubbles.length - 1];
    const key = last?.key ?? null;
    if (key === lastKey.current) return;
    const previous = lastKey.current;
    lastKey.current = key;
    if (!last) return;
    if (!firstShown.current) {
      firstShown.current = true;
      // The pane opens its thread at the newest message; the phone's page stays where it is (the request's top).
      if (panel) scrollToEnd(false);
      else atBottom.current = measureAtBottom();
      // (2026-11-08) The thread came in under a phone's jump (however late, the reader hasn't moved the page since):
      // land again, so the newest messages and the field end up above the bar, not under it, held like the jump's own
      // landing (a smooth scroll that stops short is aimed again without animation).
      if (section.current && settle.current) {
        landSection(motion());
        atBottom.current = true;
        ownScroll.current = Date.now() + OWN_SCROLL_MS;
      }
      unsettle.current();
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
    // Reading higher up: nothing moves, the pill says so (on a phone just above the action bar).
    const lift = pillLift();
    const frame = requestAnimationFrame(() => setNewPill(lift));
    return () => cancelAnimationFrame(frame);
  }, [bubbles, scrollToEnd, measureAtBottom, pillLift, panel, landSection]);

  /** (Phone) The check after this thread's own scroll to its end has finished. */
  const later = useRef(0);
  const onScroll = useCallback(() => {
    // "Earlier messages" while it loads: the kept bubble's top is where the reader's own scrolling has put it.
    const held = anchor.current;
    if (held) held.top = bubbleTop(box.current, held.key, panel) ?? held.top;
    const check = () => {
      atBottom.current = measureAtBottom();
      if (atBottom.current) {
        setNewPill(null);
        return;
      }
      // The pill stays just above the bar, or the keyboard, as they come and go (a phone's keyboard pans and resizes).
      const lift = pillLift();
      setNewPill((p) => (p === null ? null : lift));
    };
    window.clearTimeout(later.current);
    const wait = panel ? 0 : ownScroll.current - Date.now();
    if (wait > 0) later.current = window.setTimeout(check, wait);
    else check();
  }, [panel, measureAtBottom, pillLift]);

  // (2026-11-08) The phone's thread scrolls with the page: the page's scroll (and the keyboard's) decides atBottom.
  useEffect(() => {
    if (panel) return;
    const vv = window.visualViewport;
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    vv?.addEventListener('resize', onScroll);
    vv?.addEventListener('scroll', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      vv?.removeEventListener('resize', onScroll);
      vv?.removeEventListener('scroll', onScroll);
      window.clearTimeout(later.current);
    };
  }, [panel, onScroll]);

  const loadEarlier = () => {
    // The first bubble's place on screen now: it stays there once the older messages show above it.
    const first = bubbles[0];
    const top = first ? bubbleTop(box.current, first.key, panel) : null;
    anchor.current = first && top !== null && thread?.hasEarlier && !thread.loadingEarlier ? { key: first.key, top } : null;
    void api?.loadEarlier(row.id);
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
  // computer only (a phone keeps its keyboard down: the heading takes the focus). (2026-11-08) On a phone the page
  // lands with the message field above the sticky action bar and the newest messages over it, the heading going under
  // the top bar when the section can't fit; a jump that lands while the thread is still loading lands again when it
  // shows, however long that takes, unless the reader touches, scrolls or types first. The desk pane scrolls itself to
  // the section and its thread to the newest. Either way the landing is held while the request settles (holdLanding:
  // the thread replacing its skeleton, the details or a photo loading, a smooth scroll WebKit stopped short). --------
  useEffect(() => {
    const id = row.id;
    let frame = 0;
    const land = () => {
      if (!threadJumpWaiting(id) || frame) return;
      // After this commit's other effects (the page and the desk pane start a request at its top).
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!takeThreadJump(id)) return;
        unsettle.current();
        if (!panel && !firstShown.current) {
          settle.current = true;
          const off = () => {
            settle.current = false;
            unsettle.current = () => undefined;
            READER_INPUT.forEach((type) => window.removeEventListener(type, off, true));
          };
          READER_INPUT.forEach((type) => window.addEventListener(type, off, { capture: true, passive: true }));
          unsettle.current = off;
        }
        landSection(motion());
        if (panel) scrollToEnd(false);
        else {
          atBottom.current = true;
          ownScroll.current = Date.now() + OWN_SCROLL_MS;
        }
        setNewPill(null);
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
      unsettle.current();
      holding.current();
    };
  }, [row.id, panel, scrollToEnd, landSection]);

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
      <div className={s.thread} ref={box} onScroll={panel ? onScroll : undefined} data-testid="thread">
        {thread?.hasEarlier ? (
          <Button variant="ghost" color="gray" size="2" className={`${s.earlier} lp-hit`} loading={thread.loadingEarlier} onClick={loadEarlier}>
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
            {bubbles.map((b, i) => {
              const time = timeOf(b.createdAt, now, timeZone);
              return (
                <Fragment key={b.key}>
                  {b.runStart && i > 0 ? <div className={s.gap} aria-hidden /> : null}
                  {b.runStart ? <RunLabel bubble={b} time={time} /> : null}
                  <BubbleRow
                    bubble={b}
                    time={time}
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
              );
            })}
          </div>
        )}
        {newPill !== null ? (
          <button type="button" className={s.newPill} style={{ bottom: newPill }} onClick={toBottom} data-testid="new-messages">
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
      />
      {enroute.sheet}
    </section>
  );
}

/** "12:14 PM" ("Thu 11:02 PM" an earlier day) for a bubble's run label and its screen-reader label; '' when unreadable. */
export function timeOf(iso: string, now: number, timeZone: string): string {
  return Number.isFinite(Date.parse(iso)) ? formatCreatedTime(iso, now, timeZone) : '';
}

/**
 * (2026-11-08, T5) The line over a run: "Rae C. · Medical · 12:14 PM" over someone else's, the time alone at the right
 * over mine. Hidden from screen readers: each bubble's label says who and when.
 */
export function RunLabel({ bubble, time }: { bubble: Pick<Bubble, 'by' | 'team' | 'mine'>; time: string }) {
  if (bubble.mine) {
    return time ? (
      <span className={`${s.from} ${s.fromMe}`} aria-hidden data-testid="run-label" data-mine="">
        {time}
      </span>
    ) : null;
  }
  return (
    <span className={s.from} aria-hidden data-testid="run-label">
      <b>{bubble.by}</b>
      {bubble.team ? ` · ${bubble.team}` : ''}
      {time ? ` · ${time}` : ''}
    </span>
  );
}

/** A bubble's screen-reader label: "Rae C., Medical, 12:14 PM: Any tattoos or marks?." / "You, 12:16 PM: …. Sending.". */
export function bubbleSaid(bubble: Pick<Bubble, 'by' | 'team' | 'mine' | 'body' | 'pending'>, time: string): string {
  const who = bubble.mine ? 'You' : `${bubble.by}${bubble.team ? `, ${bubble.team}` : ''}`;
  const state = bubble.pending === 'sending' ? ' Sending.' : bubble.pending === 'failed' ? ' Not delivered.' : '';
  return `${who}${time ? `, ${time}` : ''}: ${bubble.body}.${state}`;
}

const motion = (): ScrollBehavior => (window.matchMedia(REDUCED_MOTION).matches ? 'auto' : 'smooth');

/** The request's own scroller: the desk pane's body, or null for the page. */
function scrollBoxOf(el: HTMLElement): HTMLElement | null {
  for (let box = el.parentElement; box && box !== document.body && box !== document.documentElement; box = box.parentElement) {
    const overflow = getComputedStyle(box).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return box;
  }
  return null;
}

/**
 * (R2, design/screens/msg-indicator-5.png) Where a jump lands, as the scroller's scrollTop: the section's top under its
 * scroll-margin (the Messages heading right under the phone's top bar, 4 px into the desk pane), or a little further
 * where the screen is too short for the whole section. In the desk pane, so the section's end (the composer) clears
 * the pane's bottom edge by KEEP_GAP_PX. (2026-11-08) On the page (a phone), so `keep` (the message field) ends at least
 * KEEP_GAP_PX above the request's sticky action bar, or the keyboard while it is up (pageView): the newest messages sit
 * right above it.
 */
function landingTop(el: HTMLElement, box: HTMLElement | null, keep: HTMLElement | null): number {
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  const rect = el.getBoundingClientRect();
  if (box) {
    const frame = box.getBoundingClientRect();
    const foot = box.querySelector<HTMLElement>('[data-sticky-foot]');
    const visibleBottom = frame.bottom - (foot ? foot.offsetHeight : 0);
    return box.scrollTop + Math.max(rect.top - frame.top - margin, rect.bottom + KEEP_GAP_PX - visibleBottom);
  }
  const head = rect.top - margin;
  return window.scrollY + (keep ? Math.max(head, keep.getBoundingClientRect().bottom - pageView(el).bottom) : head);
}

/**
 * (R2) Scrolls the request's own scroller (the desk pane's body, else the page) so the section lands (landingTop).
 * Not scrollIntoView: that moves every scroller around it, the desk's list included.
 */
function scrollToSection(el: HTMLElement, behavior: ScrollBehavior, keep: HTMLElement | null = null): void {
  const box = scrollBoxOf(el);
  const to = { top: landingTop(el, box, keep), behavior };
  if (box) box.scrollTo(to);
  else window.scrollTo(to);
}

/** How long a jump keeps its landing while the request settles. */
const HOLD_MS = 5_000;
/** A jump's smooth scroll has ended by now (or stopped short: WebKit stops one when the page grows under it). */
const SETTLE_MS = 900;

/**
 * (R2) Holds a jump's landing while the request settles. What shows after the jump (the thread replacing its
 * skeleton, the request's details, a photo) changes the height around the section, so a scroll aimed before that
 * stops short (the page could not yet scroll that far) or lands off. Until the reader scrolls, taps or types
 * (READER_INPUT), or HOLD_MS pass, every change of the layout aims it again, without animation, as does the end of
 * the smooth scroll. A scroll from anywhere else (the status bar, a scrollbar, a script) hands it back too. Call it
 * right after the jump's scrollToSection, with the same `keep`. Returns the release.
 * (2026-11-08) A phone's thread that shows only after HOLD_MS still lands again, from MessagesSection's settle.
 */
function holdLanding(el: HTMLElement, keep: HTMLElement | null): () => void {
  const box = scrollBoxOf(el);
  const at = () => (box ? box.scrollTop : window.scrollY);
  // The smooth scroll's goal, and where it has got to: it only ever closes in on the goal.
  const goal = landingTop(el, box, keep);
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
    scrollToSection(el, 'auto', keep);
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
  for (const type of READER_INPUT) window.addEventListener(type, release, { capture: true, passive: true });
  const settleTimer = window.setTimeout(settle, SETTLE_MS);
  const holdTimer = window.setTimeout(release, HOLD_MS);
  function release() {
    if (done) return;
    done = true;
    observer?.disconnect();
    scroller.removeEventListener('scroll', onScroll);
    scroller.removeEventListener('scrollend', settle);
    for (const type of READER_INPUT) window.removeEventListener(type, release, { capture: true });
    window.clearTimeout(settleTimer);
    window.clearTimeout(holdTimer);
  }
  return release;
}

/**
 * (2026-11-08) What of the phone's page is on screen around the request's thread, in viewport px: from under the sticky
 * top bar (the section's scroll-margin) to KEEP_GAP_PX above the sticky action bar (ProfileView's [data-sticky-foot]),
 * or above the on-screen keyboard while it is up (it covers the bar; the visual viewport is what shows).
 */
function pageView(el: HTMLElement): { top: number; bottom: number } {
  const sec = el.closest<HTMLElement>('[data-testid="messages"]') ?? el;
  const bar = el.closest('[data-testid="profile"]')?.querySelector<HTMLElement>('[data-sticky-foot]');
  const vv = window.visualViewport;
  const keyboard = vv ? keyboardBox(window.innerHeight, vv) : null;
  const shown = keyboard ? keyboard.top + keyboard.height : window.innerHeight;
  const bottom = Math.min(window.innerHeight - (bar?.offsetHeight ?? 0), shown) - KEEP_GAP_PX;
  return { top: parseFloat(getComputedStyle(sec).scrollMarginTop) || 0, bottom };
}

/**
 * The top of the bubble row `key` in the thread `box`, or null when it isn't there: on screen (viewport px), or in the
 * desk pane (`inBox`) from the top of the box that scrolls it, so scrolling the pane around the box doesn't count.
 */
function bubbleTop(box: HTMLElement | null, key: string, inBox: boolean): number | null {
  const el = box?.querySelector<HTMLElement>(`[data-bubble="${CSS.escape(key)}"]`);
  if (!box || !el) return null;
  return el.getBoundingClientRect().top - (inBox ? box.getBoundingClientRect().top : 0);
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
  time,
  now,
  onCopy,
  onUnsend,
  onRetry,
  onDelete,
}: {
  bubble: Bubble;
  /** "12:14 PM": said in the bubble's label (the run's label shows it once on screen). */
  time: string;
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
    <div className={s.row} data-mine={bubble.mine ? '' : undefined} data-bubble={bubble.key}>
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
            aria-label={bubbleSaid(bubble, time)}
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
}: {
  lines: ReturnType<typeof quickLines>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onSendText: (text: string) => Promise<boolean>;
  onEnroute: () => void;
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
                else fill(l.text);
              }}
              aria-label={l.kind === 'enroute' ? 'En route: bringing the friend' : `Add to message: ${l.text}`}
            >
              {l.kind === 'enroute' ? <WalkIcon size={15} strokeWidth={2} aria-hidden /> : null}
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
