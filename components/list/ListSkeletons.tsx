'use client';
// Loading placeholders shaped like what will load (design/screens/skeletons.html), built with Radix
// <Skeleton>. Shown only while there is no cached data yet.
import { Skeleton } from '@radix-ui/themes';
import s from './list.module.css';

const Sk = ({ w, h = 12, r }: { w: string; h?: number; r?: string }) => (
  <Skeleton width={w} height={`${h}px`} style={r ? { borderRadius: r } : undefined} />
);

// Varied name and status widths so the skeleton reads like the log, not a grid of identical bars.
const LOG_WIDTHS: ReadonlyArray<readonly [string, string]> = [
  ['44%', '96px'],
  ['70%', '96px'],
  ['38%', '96px'],
  ['52%', '64px'],
  ['46%', '64px'],
  ['60%', '72px'],
  ['40%', '64px'],
];

/**
 * All requests (log option B): one-line rows in the log's columns, number · name · status glyph and label ·
 * created · updated, each 48 px with the hairline inset from the name.
 */
export function AllSkeleton() {
  return (
    <div className={s.skLog} aria-busy="true" aria-label="Loading requests" data-testid="list-skeleton">
      {LOG_WIDTHS.map(([name, status], i) => (
        <div key={i} className={s.skLogRow}>
          <Sk w="32px" h={11} />
          <span className={s.skName}>
            <Sk w={name} h={13} />
          </span>
          <span className={s.skStatus}>
            <Sk w="14px" h={14} r="50%" />
            <Sk w={status} h={10} />
          </span>
          <Sk w="48px" h={11} />
          <Sk w="22px" h={11} />
        </div>
      ))}
    </div>
  );
}

/** A Waiting for check card (pending-v8.html): name and minutes, two lines of what they wear, the quiet line, two 44 px answers. */
function PendingCardSkeleton() {
  return (
    <div className={s.skCard}>
      <div className={s.skL} style={{ justifyContent: 'space-between' }}>
        <Sk w="38%" h={16} />
        <Sk w="36px" h={12} />
      </div>
      <div className={s.skRm}>
        <Sk w="92%" h={12} />
        <Sk w="64%" h={12} />
        <Sk w="30%" h={10} />
      </div>
      <div className={s.pacts}>
        <Sk w="100%" h={44} r="10px" />
        <Sk w="100%" h={44} r="10px" />
      </div>
    </div>
  );
}

/** Pending: the large title is already there; only the cards are placeholders. */
export function PendingSkeleton() {
  return (
    <div className={s.skScroll} aria-busy="true" aria-label="Loading requests" data-testid="list-skeleton">
      <PendingCardSkeleton />
      <PendingCardSkeleton />
      <PendingCardSkeleton />
    </div>
  );
}

function MineCardSkeleton() {
  return (
    <div className={s.skCard}>
      <div className={s.skL} style={{ alignItems: 'flex-start', gap: 12 }}>
        <Sk w="40px" h={40} r="8px" />
        <div className={s.skRm}>
          <Sk w="50%" h={14} />
          <Sk w="32%" h={10} />
        </div>
        <Sk w="28px" h={10} />
      </div>
      <Sk w="58%" h={13} />
      <div className={s.skL} style={{ justifyContent: 'space-between' }}>
        {[0, 1, 2, 3].map((i) => (
          <Sk key={i} w="10px" h={10} r="50%" />
        ))}
      </div>
    </div>
  );
}

export function MineSkeleton() {
  return (
    <div className={s.skScroll} aria-busy="true" aria-label="Loading requests" data-testid="list-skeleton">
      <MineCardSkeleton />
      <MineCardSkeleton />
      <MineCardSkeleton />
    </div>
  );
}
