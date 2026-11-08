'use client';
// Loading skeletons with Radix <Skeleton> (design/screens/skeletons.html), shown only while there is no
// cache yet. Only the data is a placeholder: the header and the view switcher are the real ones.
import { IconButton, Skeleton } from '@radix-ui/themes';
import { Ellipsis, X } from 'lucide-react';
import { goBack } from '@/lib/client/nav';
import styles from './ui.module.css';

/** The mockup's S(width, height, radius). */
function S({ w, h = 12, r }: { w: string; h?: number; r?: string }) {
  return <Skeleton width={w} height={`${h}px`} style={r ? { borderRadius: r, flex: 'none' } : { flex: 'none' }} />;
}

// Varied name and status widths so the skeleton reads like the log, not a grid of identical bars.
const ROW_WIDTHS: ReadonlyArray<readonly [string, string]> = [
  ['44%', '96px'],
  ['70%', '96px'],
  ['38%', '96px'],
  ['52%', '64px'],
  ['46%', '64px'],
  ['60%', '72px'],
  ['40%', '64px'],
];

/**
 * All requests (log option B): one-line rows in the log's columns, the message lane (empty) · name · status glyph and
 * label · created · updated (varying widths). The same shape as the list's own AllSkeleton
 * (components/list/ListSkeletons.tsx), so nothing moves when one replaces the other.
 */
export function RowSkeletons({ count = 8 }: { count?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading requests" role="status">
      {Array.from({ length: count }, (_, i) => {
        const [name, status] = ROW_WIDTHS[i % ROW_WIDTHS.length] as readonly [string, string];
        return (
          <div key={i} className={styles.skLogRow}>
            <span />
            <div className={styles.skLine}>
              <S w={name} h={13} />
            </div>
            <div className={styles.skLine} style={{ gap: 6 }}>
              <S w="14px" h={14} r="50%" />
              <S w={status} h={10} />
            </div>
            <S w="48px" h={11} />
            <S w="22px" h={11} />
          </div>
        );
      })}
    </div>
  );
}

function PendingCard() {
  return (
    <div className={styles.skCard}>
      <div className={styles.skLine} style={{ alignItems: 'flex-start', gap: 12 }}>
        <S w="40px" h={40} r="8px" />
        <div className={styles.skMain}>
          <S w="55%" h={14} />
          <S w="35%" h={10} />
        </div>
        <S w="44px" h={20} r="6px" />
      </div>
      <div className={styles.skMain}>
        <S w="92%" h={11} />
        <S w="64%" h={11} />
      </div>
      <div className={styles.skButtons}>
        <S w="100%" h={32} r="8px" />
        <S w="100%" h={32} r="8px" />
      </div>
    </div>
  );
}

function MineCard() {
  return (
    <div className={styles.skCard}>
      <div className={styles.skLine} style={{ alignItems: 'flex-start', gap: 12 }}>
        <S w="40px" h={40} r="8px" />
        <div className={styles.skMain}>
          <S w="50%" h={14} />
          <S w="32%" h={10} />
        </div>
        <S w="28px" h={10} />
      </div>
      <S w="58%" h={13} />
      <div className={styles.skLine} style={{ justifyContent: 'space-between' }}>
        {[0, 1, 2, 3].map((i) => (
          <S key={i} w="10px" h={10} r="50%" />
        ))}
      </div>
    </div>
  );
}

/**
 * Pending (section labels, cards with a photo square, two text lines and two button blocks) or My requests
 * (cards with a progress line of four dots).
 */
export function CardSkeletons({ count = 3, variant }: { count?: number; variant: 'pending' | 'mine' }) {
  const cards = Array.from({ length: Math.max(1, count) }, (_, i) => i);
  return (
    <div aria-busy="true" aria-label="Loading requests" role="status" className={styles.skScroll}>
      {variant === 'pending' ? (
        <>
          <S w="80px" h={12} />
          {cards.slice(0, -1).map((i) => (
            <PendingCard key={i} />
          ))}
          {cards.length > 1 ? <S w="64px" h={12} /> : null}
          <PendingCard />
        </>
      ) : (
        cards.map((i) => <MineCard key={i} />)
      )}
    </div>
  );
}

export interface ProfileSkeletonProps {
  /**
   * Render the profile's top bar (× · LP placeholder · ⋯) and the sticky action placeholders around the
   * body. Default true: the skeleton stands in for the whole view (its × goes back). Pass false inside a
   * view that draws its own top bar.
   */
  chrome?: boolean;
  /** The × button (default: back to the list). */
  onClose?: () => void;
}

/** Profile: portrait, name lines, the status block, detail rows, and the action buttons (status unknown yet). */
export function ProfileSkeleton({ chrome = true, onClose }: ProfileSkeletonProps = {}) {
  return (
    <div aria-busy="true" aria-label="Loading request" role="status">
      {chrome ? (
        <div className={styles.skNav}>
          <IconButton variant="soft" color="gray" radius="full" aria-label="Close" onClick={onClose ?? (() => goBack({}))}>
            <X size={16} strokeWidth={1.75} aria-hidden />
          </IconButton>
          <S w="64px" h={12} />
          <IconButton variant="soft" color="gray" radius="full" aria-label="More" disabled>
            <Ellipsis size={16} strokeWidth={1.75} aria-hidden />
          </IconButton>
        </div>
      ) : null}
      <div className={styles.skBody}>
        <div className={styles.skLine} style={{ gap: 14 }}>
          <S w="64px" h={82} r="8px" />
          <div className={styles.skMain}>
            <S w="62%" h={20} />
            <S w="30%" h={13} />
            <S w="48%" h={10} />
          </div>
        </div>
        <S w="100%" h={56} r="10px" />
        <div className={styles.skGroup}>
          {['70%', '55%', '40%'].map((w) => (
            <div key={w} className={styles.skGroupRow}>
              <S w="56px" h={11} />
              <S w={w} h={12} />
            </div>
          ))}
        </div>
        <div className={styles.skGroup}>
          {['50%', '44%'].map((w) => (
            <div key={w} className={styles.skGroupRow}>
              <S w="56px" h={11} />
              <S w={w} h={12} />
            </div>
          ))}
        </div>
      </div>
      {chrome ? (
        <div className={styles.skFoot}>
          <S w="100%" h={40} r="8px" />
          <S w="100%" h={40} r="8px" />
        </div>
      ) : null}
    </div>
  );
}
