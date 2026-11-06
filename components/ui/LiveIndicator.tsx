'use client';
// The line under the view title (v2.2 afternoon, Brian 2026-11-06: the Apple Mail model) on All requests,
// Pending and My requests, and in the dashboard header. A plain solid dot carries the state (green, amber or
// gray, matching the banner); the words say when the data last arrived, in minutes ("Updated just now",
// "Updated 5 min ago"), or as a fixed clock time while a banner shows ("Last updated 3:42 PM"). Then a small
// Refresh now button. The words and the state come from the view's useLiveStatus() (lib/client/
// live-status.ts), the same object its banner and avatar badge read.
//
// Screen readers get the line as one sentence ("List updated just now.") instead of the clipped visible words.
// State changes are announced once, by the view's ConnectionBanner, never by this line. The line keeps its
// height before the first sync (when it shows nothing), so nothing under it moves when it appears.
import { VisuallyHidden } from '@radix-ui/themes';
import { RefreshCw } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import type { LiveLine } from '@/lib/client/live-status';
import styles from './ui.module.css';

/** One turn of the Refresh glyph (ui.module.css .liveRefresh). The spin stops at the end of a turn. */
export const SPIN_MS = 800;

export const REFRESH_LABEL = 'Refresh now';

/**
 * How long the glyph keeps turning once the refresh has settled: to the end of the turn it is in (at least one
 * whole turn), so the arrow never snaps back mid-spin.
 */
export function spinStopDelay(elapsedMs: number): number {
  return Math.ceil(Math.max(1, elapsedMs) / SPIN_MS) * SPIN_MS - elapsedMs;
}

export interface RefreshButtonProps {
  /** Starts the refresh; the glyph turns until it settles (and repeat taps are ignored meanwhile). */
  onRefresh: () => Promise<unknown> | void;
}

/** The refresh-cw icon button: 32 px, a 44 px tap target, "Refresh now". Never reloads the page. */
export function RefreshButton({ onRefresh }: RefreshButtonProps) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const tap = () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const started = Date.now();
    void Promise.resolve()
      .then(onRefresh)
      .catch(() => undefined)
      .then(() => {
        // Finish the turn it is in (with reduced motion it only dims, for as long).
        setTimeout(() => {
          busyRef.current = false;
          if (mounted.current) setBusy(false);
        }, spinStopDelay(Date.now() - started));
      });
  };

  return (
    <button
      type="button"
      className={styles.liveRefresh}
      aria-label={REFRESH_LABEL}
      data-refreshing={busy ? '' : undefined}
      data-testid="refresh-now"
      onClick={tap}
    >
      <RefreshCw size={15} strokeWidth={2} aria-hidden />
    </button>
  );
}

export interface LiveIndicatorProps {
  /** The view's useLiveStatus() result. */
  line: LiveLine;
  onRefresh: () => Promise<unknown> | void;
  className?: string;
}

export const LiveIndicator = memo(function LiveIndicator({ line, onRefresh, className }: LiveIndicatorProps) {
  return (
    <div
      className={`${styles.live}${className ? ` ${className}` : ''}`}
      data-state={line.text ? line.state : 'none'}
      data-testid="live-indicator"
    >
      {line.text ? (
        <>
          <span className={styles.liveDot} aria-hidden />
          <span className={styles.liveText} aria-hidden data-testid="live-text">
            {line.text}
          </span>
          <VisuallyHidden>{line.sentence}</VisuallyHidden>
          <RefreshButton onRefresh={onRefresh} />
        </>
      ) : null}
    </div>
  );
});
