'use client';
// The live indicator (design/screens/live-indicator.html, approved by Brian 2026-11-06): one quiet line under
// the view title on All requests, Pending and My requests, and in the dashboard header. A plain solid dot
// (no ring, no glow) carries the state; the words say when the data last arrived. The states and words are
// in lib/client/live-status.ts.
//
// Screen readers get the line as one sentence ("List updated 6 seconds ago") instead of the clipped visible
// words, and a polite live region announces only a change of state ("List is live", "Reconnecting",
// "Offline"), never the ticking. The line keeps its height before the first sync (when it shows nothing), so
// nothing under it moves when it appears.
import { VisuallyHidden } from '@radix-ui/themes';
import { useMemo, useState, useSyncExternalStore } from 'react';
import {
  liveAnnouncement,
  liveLine,
  readDeviceOnline,
  readSecondClock,
  subscribeDeviceOnline,
  subscribeSecondClock,
  type LiveInput,
  type LiveLine,
  type LiveState,
} from '@/lib/client/live-status';
import type { Connection } from '@/lib/client/store-contract';
import styles from './ui.module.css';

export interface LiveIndicatorProps {
  /** This phone's clock (epoch ms) when the data last arrived; null before the first time: nothing shows. */
  syncedAt: number | null;
  connection: Connection;
  /** The view's own fetch is failing (the dashboard's stats): Reconnecting. */
  failing?: boolean;
  /** Starts the spoken sentence and the live announcement: "List updated …", "Dashboard is live". */
  subject?: string;
  className?: string;
}

const sameLine = (a: LiveLine | null, b: LiveLine | null) =>
  a === b || (!!a && !!b && a.state === b.state && a.text === b.text && a.sentence === b.sentence);

/**
 * A snapshot reader for useSyncExternalStore: the line at the clock's current time, and the very same object
 * while the words are unchanged, so the indicator re-renders only when they change (every second at most).
 */
function lineReader(input: Omit<LiveInput, 'now' | 'visibleSince'>, subject: string): () => LiveLine | null {
  let last: LiveLine | null = null;
  return () => {
    const { now, visibleSince } = readSecondClock();
    const next = liveLine({ ...input, now, visibleSince }, subject);
    if (!sameLine(last, next)) last = next;
    return last;
  };
}

const serverOnline = () => true;

export function LiveIndicator({ syncedAt, connection, failing = false, subject = 'List', className }: LiveIndicatorProps) {
  const online = useSyncExternalStore(subscribeDeviceOnline, readDeviceOnline, serverOnline);
  const getLine = useMemo(
    () => lineReader({ syncedAt, connection, online, failing }, subject),
    [syncedAt, connection, online, failing, subject],
  );
  const line = useSyncExternalStore(subscribeSecondClock, getLine, getLine);
  const state: LiveState | null = line?.state ?? null;

  // The live region speaks when the state changes while this line is on screen, not when it first appears.
  const [spoken, setSpoken] = useState<{ state: LiveState | null; text: string }>({ state, text: '' });
  if (spoken.state !== state) setSpoken({ state, text: spoken.state && state ? liveAnnouncement(state, subject) : '' });

  return (
    <div className={`${styles.live}${className ? ` ${className}` : ''}`} data-state={state ?? 'none'} data-testid="live-indicator">
      {line ? (
        <>
          <span className={styles.liveDot} aria-hidden />
          <span className={styles.liveText} aria-hidden data-testid="live-text">
            {line.lead ? <span className={styles.liveLead}>{line.lead}</span> : null}
            {line.text}
          </span>
          <VisuallyHidden>{line.sentence}</VisuallyHidden>
        </>
      ) : null}
      <VisuallyHidden role="status" data-testid="live-announcement">
        {spoken.text}
      </VisuallyHidden>
    </div>
  );
}
