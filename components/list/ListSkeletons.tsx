'use client';
// Loading placeholders shaped like what will load (design/screens/skeletons.html), built with Radix
// <Skeleton>. Shown only while there is no cached data yet.
import { Skeleton } from '@radix-ui/themes';
import s from './list.module.css';

const Sk = ({ w, h = 12, r }: { w: string; h?: number; r?: string }) => (
  <Skeleton width={w} height={`${h}px`} style={r ? { borderRadius: r } : undefined} />
);

// Varied widths so the skeleton reads like text, not a grid of identical bars.
const WIDTHS: ReadonlyArray<readonly [string, string]> = [
  ['46%', '22%'],
  ['60%', '30%'],
  ['38%', '26%'],
  ['52%', '34%'],
  ['44%', '20%'],
  ['56%', '28%'],
  ['40%', '24%'],
];

export function AllSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading requests" data-testid="list-skeleton">
      {WIDTHS.map(([a, b], i) => (
        <div key={i} className={s.skRow}>
          <Sk w="14px" h={14} r="50%" />
          <div className={s.skRm}>
            <div className={s.skL}>
              <Sk w={a} h={13} />
              <span className={s.sp} />
              <Sk w="34px" h={11} />
            </div>
            <div className={s.skL}>
              <Sk w={b} h={10} />
              <Sk w="22%" h={10} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PendingCardSkeleton() {
  return (
    <div className={s.skCard}>
      <div className={s.skL} style={{ alignItems: 'flex-start', gap: 12 }}>
        <Sk w="40px" h={40} r="8px" />
        <div className={s.skRm}>
          <Sk w="55%" h={14} />
          <Sk w="35%" h={10} />
        </div>
        <Sk w="44px" h={20} r="6px" />
      </div>
      <div className={s.skRm}>
        <Sk w="92%" h={11} />
        <Sk w="64%" h={11} />
      </div>
      <div className={s.qa}>
        <Sk w="100%" h={32} r="8px" />
        <Sk w="100%" h={32} r="8px" />
      </div>
    </div>
  );
}

export function PendingSkeleton() {
  return (
    <div className={s.skScroll} aria-busy="true" aria-label="Loading requests" data-testid="list-skeleton">
      <Sk w="80px" />
      <PendingCardSkeleton />
      <PendingCardSkeleton />
      <Sk w="64px" />
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
