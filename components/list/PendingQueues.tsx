'use client';
// Pending v9.1 (Brian 2026-11-06 19:35–20:40; design/screens/pending-v9.html, pending-v9-1..5.png): the two
// queues, Waiting for check then Friend coming, each under a 44 px header row (status glyph, label, count,
// chevron) that folds it with one tap. No SegmentedControl, no Later lane, no sort control.
//
//   phone (< 768)    one scrolling page: the sections stack and their headers pin under the title while their
//                    section scrolls (components/list/ListViews.tsx PendingView).
//   desk  (≥ 768)    a two-column board, Waiting for check | Friend coming, each column scrolling on its own
//                    (components/desk/PendingBoard.tsx); the same headers, chevrons and folds.
//
// A folded Waiting header keeps the oldest wait on its right, heat-coloured. An empty Waiting section keeps its
// header with 0 (a dimmed glyph, no rows, no text) and Friend coming never moves above it. Fold memory
// (lib/client/view-prefs.ts): Waiting for this page session only, opening again when its count rises; Friend
// coming per device. The card closed by a final Not found animates out (useLeaving).
import { ChevronDown, ChevronRight, Clock } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { UnreadDot } from '@/components/messages/CardActivity';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import type { RequestSummary } from '@/lib/api-types';
import { STATUS_GROUP_META, oldestWaitMinutes } from '@/lib/client/status-order';
import { useComingFold, useWaitingFold } from '@/lib/client/view-prefs';
import { waitTone } from '@/lib/domain';
import { formatDuration } from '@/lib/format';
import { CheckCard, ComingCard, type CheckCardProps, type ComingCardProps } from './cards';
import { minutesPhrase } from './list-helpers';
import s from './list.module.css';

export type QueueKey = 'check' | 'coming';

export const QUEUE_LABEL: Readonly<Record<QueueKey, string>> = {
  check: STATUS_GROUP_META.check.label,
  coming: STATUS_GROUP_META.coming.label,
};

export interface QueueHeaderProps {
  queue: QueueKey;
  count: number;
  open: boolean;
  onToggle: () => void;
  /** The folded Waiting header's oldest wait, in minutes (null: none). */
  oldestWait?: number | null;
  /** The id of the cards this header folds (aria-controls while they are on the page). */
  controls: string;
  id?: string;
  /** (F3) After the count: the unread-messages dot of Friend coming. */
  marker?: ReactNode;
}

/**
 * One 44 px row: glyph · label · count ··· [oldest wait, folded] · chevron. The whole row is the fold button;
 * with nothing in the section it is a plain heading (dimmed glyph, 0, no chevron).
 */
export function QueueHeader({ queue, count, open, onToggle, oldestWait = null, controls, id, marker = null }: QueueHeaderProps) {
  const label = QUEUE_LABEL[queue];
  const glyph = <StatusGlyph kind={STATUS_GROUP_META[queue].glyph} size={16} />;
  if (count === 0) {
    return (
      <h2 className={s.qhead} id={id} data-zero="" data-testid={`queue-header-${queue}`}>
        <span className={s.qheadBtn}>
          <span className={s.qheadGlyph} aria-hidden>
            {glyph}
          </span>
          <span className={s.qheadLabel} aria-hidden>
            {label}
          </span>
          <span className={s.qheadCount} aria-hidden>
            0
          </span>
          <span className={s.vh}>{`${label}, no requests`}</span>
        </span>
      </h2>
    );
  }
  const showWait = !open && queue === 'check' && oldestWait !== null;
  // Named by its content (no aria-label): "Waiting for check 7 requests, longest wait 51 minutes"; the words a
  // screen reader needs and the eye does not are visually hidden, the compact "51m" is hidden from it.
  return (
    <h2 className={s.qhead} id={id} data-testid={`queue-header-${queue}`}>
      <button
        type="button"
        className={s.qheadBtn}
        aria-expanded={open}
        aria-controls={open ? controls : undefined}
        onClick={onToggle}
        data-testid={`queue-toggle-${queue}`}
      >
        <span className={s.qheadGlyph} aria-hidden>
          {glyph}
        </span>
        <span className={s.qheadLabel}>{label}</span>{' '}
        <span className={s.qheadCount}>{count}</span>
        <span className={s.vh}>{` ${count === 1 ? 'request' : 'requests'}${showWait ? ',' : ''}`}</span>
        {marker}
        {showWait ? (
          <span className={s.qheadWait} data-tone={waitTone(oldestWait)} data-testid="queue-oldest-wait">
            <Clock size={13} strokeWidth={2} aria-hidden />
            <span aria-hidden>{formatDuration(oldestWait)}</span>
            <span className={s.vh}>{` longest wait ${minutesPhrase(oldestWait)}`}</span>
          </span>
        ) : null}
        <span className={s.qheadChev} aria-hidden>
          {open ? <ChevronDown size={18} strokeWidth={2} /> : <ChevronRight size={18} strokeWidth={2} />}
        </span>
      </button>
    </h2>
  );
}

/** The final Not found's card, kept on screen for its exit animation. */
interface Ghost {
  row: RequestSummary;
  index: number;
  height: number;
}

/** How long the closed card takes to leave (list.module.css .leaving). */
export const LEAVE_MS = 240;

const reducedMotion = () => {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/**
 * The closed card animates out of Pending (Pending v9.1): `mark(id)` right before the final Not found; once the
 * request has left `rows`, a copy of its card stays where it was for LEAVE_MS while it fades and folds away.
 * Undo within that time brings the real card back and drops the copy. No animation with reduced motion.
 */
export function useLeaving(rows: readonly RequestSummary[]): {
  items: Array<{ row: RequestSummary; leaving: boolean; height?: number }>;
  mark: (id: string) => void;
  /** Forget a mark the request never left on (the tap failed or changed nothing). */
  unmark: (id: string) => void;
} {
  const [ghosts, setGhosts] = useState<ReadonlyMap<string, Ghost>>(() => new Map());
  const marked = useRef(new Map<string, number>());
  const previous = useRef(rows);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const mark = useCallback((id: string) => {
    if (reducedMotion()) return;
    // Request ids are UUIDs: safe in an attribute selector as they are.
    const el = typeof document === 'undefined' ? null : document.querySelector<HTMLElement>(`[data-pending-card="${id}"]`);
    marked.current.set(id, el?.offsetHeight ?? 0);
  }, []);
  const unmark = useCallback((id: string) => {
    marked.current.delete(id);
  }, []);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = rows;
    if (marked.current.size === 0) return;
    const ids = new Set(rows.map((r) => r.id));
    const gone: Ghost[] = [];
    before.forEach((row, index) => {
      const height = marked.current.get(row.id);
      if (height === undefined || ids.has(row.id)) return;
      marked.current.delete(row.id);
      gone.push({ row, index, height });
    });
    if (gone.length === 0) return;
    setGhosts((cur) => {
      const next = new Map(cur);
      for (const g of gone) next.set(g.row.id, g);
      return next;
    });
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setGhosts((cur) => {
        const next = new Map(cur);
        for (const g of gone) next.delete(g.row.id);
        return next;
      });
    }, LEAVE_MS);
    timers.current.add(timer);
  }, [rows]);

  const items = useMemo(() => {
    const out: Array<{ row: RequestSummary; leaving: boolean; height?: number }> = rows.map((row) => ({ row, leaving: false }));
    if (ghosts.size === 0) return out;
    const ids = new Set(rows.map((r) => r.id));
    const list = [...ghosts.values()].filter((g) => !ids.has(g.row.id)).sort((a, b) => a.index - b.index);
    for (const g of list) out.splice(Math.min(g.index, out.length), 0, { row: g.row, leaving: true, height: g.height });
    return out;
  }, [rows, ghosts]);

  return { items, mark, unmark };
}

export interface PendingQueuesProps extends Pick<CheckCardProps, 'now' | 'offline' | 'onInMedical'>, Pick<ComingCardProps, 'onReunited' | 'onLocate'> {
  /** Waiting for check in rule 2's order (status-order.ts waitingOrder). */
  waiting: readonly RequestSummary[];
  /** Friend coming in rule 4's order (status-order.ts friendComingOrder). */
  coming: readonly RequestSummary[];
  /** A Not found tap (the hold, or the final answer that closes the request). */
  onNotFound: CheckCardProps['onNotInMedical'];
  /** `useLeaving(waiting)` of the view: the closed card's exit. */
  leaving: ReturnType<typeof useLeaving>;
  /** Board: the desk's column classes and test ids. */
  variant?: 'phone' | 'board';
  /** The board's class names (components/desk/pending-board.module.css). */
  boardClasses?: { col?: string; cards?: string };
}

/** Waiting for check, then Friend coming. */
export function PendingQueues({ waiting, coming, now, offline, onNotFound, onInMedical, onReunited, onLocate, leaving, variant = 'phone', boardClasses }: PendingQueuesProps) {
  const [waitFolded, setWaitFolded] = useWaitingFold(waiting.length);
  const [comingFolded, setComingFolded] = useComingFold();
  const oldest = useMemo(() => oldestWaitMinutes(waiting, now), [waiting, now]);
  return (
    <>
      <Queue
        queue="check"
        count={waiting.length}
        hasCards={leaving.items.length > 0}
        open={!waitFolded}
        onToggle={() => setWaitFolded(!waitFolded)}
        oldestWait={oldest}
        variant={variant}
        boardClasses={boardClasses}
      >
        {leaving.items.map(({ row, leaving: out, height }) =>
          out ? (
            <div key={`leaving-${row.id}`} className={s.leaveWrap} style={{ ['--leave-h' as string]: `${height ?? 0}px` }}>
              <CheckCard row={row} now={now} offline={offline} onNotInMedical={noop} onInMedical={noop} leaving />
            </div>
          ) : (
            <CheckCard key={row.id} row={row} now={now} offline={offline} onNotInMedical={onNotFound} onInMedical={onInMedical} />
          ),
        )}
      </Queue>
      <Queue
        queue="coming"
        count={coming.length}
        hasCards={coming.length > 0}
        open={!comingFolded}
        onToggle={() => setComingFolded(!comingFolded)}
        marker={<UnreadDot rows={coming} label="Unread messages" />}
        variant={variant}
        boardClasses={boardClasses}
      >
        {coming.map((row) => (
          <ComingCard key={row.id} row={row} now={now} offline={offline} onReunited={onReunited} onLocate={onLocate} />
        ))}
      </Queue>
    </>
  );
}

const noop = () => undefined;

function Queue({
  queue,
  count,
  hasCards,
  open,
  onToggle,
  oldestWait = null,
  marker = null,
  variant,
  boardClasses,
  children,
}: {
  queue: QueueKey;
  count: number;
  /** Cards to show: the count's, plus a closed card still animating out. */
  hasCards: boolean;
  open: boolean;
  onToggle: () => void;
  oldestWait?: number | null;
  marker?: ReactNode;
  variant: 'phone' | 'board';
  boardClasses?: { col?: string; cards?: string };
  children: ReactNode;
}) {
  const base = useId();
  const headingId = `${base}-h`;
  const cardsId = `${base}-cards`;
  const board = variant === 'board';
  const shown = (open || count === 0) && hasCards;
  return (
    <section
      className={board ? boardClasses?.col : s.qsec}
      aria-labelledby={headingId}
      data-queue={queue}
      data-open={shown ? '' : undefined}
      data-testid={board ? `pending-column-${queue}` : `pending-section-${queue}`}
    >
      <QueueHeader queue={queue} count={count} open={open} onToggle={onToggle} oldestWait={oldestWait} controls={cardsId} id={headingId} marker={marker} />
      {shown ? (
        <div id={cardsId} className={board ? boardClasses?.cards : s.qcards}>
          {children}
        </div>
      ) : null}
    </section>
  );
}
