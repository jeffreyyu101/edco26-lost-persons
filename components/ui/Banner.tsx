'use client';
// Inline status banner (states.html .bnr — "Offline · 2 waiting to send", "Reconnecting…", "Updated by
// someone else", "Update ready · Reload").
//
// ConnectionBanner is the connection banner (v2.2 afternoon, Brian 2026-11-06): amber "Reconnecting…" while
// syncs fail with a connection, gray "Offline · N waiting to send" with none, nothing while healthy. Its state
// is the view's useLiveStatus() (lib/client/live-status.ts), the same object the line under the title and the
// avatar badge read, so they never disagree. It also holds the one polite live region that announces a change
// of state ("Reconnecting", "Offline", "Back online"); the banner itself is not a live region, so a new
// waiting count is never read out. The shell renders one at the top of every view; a view that wants it where
// the mockup puts it (lists: under the line; the dashboard: under its header) renders <ConnectionBanner />
// there, and the shell's copy then steps aside.
import { Button, VisuallyHidden } from '@radix-ui/themes';
import { CircleAlert, CloudOff, CloudSync, Plug, RefreshCw } from 'lucide-react';
import { useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { liveAnnouncement, stateCue, type LiveLine, type LiveState } from '@/lib/client/live-status';
import { useOutbox } from '@/lib/client/store-contract';
import { useLiveStatus } from '@/lib/client/use-live-status';
import styles from './ui.module.css';

export type BannerTone = 'amber' | 'red' | 'gray' | 'blue';
export type BannerIcon = 'offline' | 'reconnecting' | 'error' | 'conflict' | 'update';

const ICONS = { offline: CloudOff, reconnecting: CloudSync, error: Plug, conflict: CircleAlert, update: RefreshCw } as const;

export interface BannerProps {
  tone: BannerTone;
  icon: BannerIcon;
  children: ReactNode;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** A polite live region (role="status", the default). The connection banner announces through its own. */
  live?: boolean;
  testId?: string;
}

export function Banner({ tone, icon, children, action, live = true, testId }: BannerProps) {
  const Icon = ICONS[icon];
  return (
    <div
      role={live ? 'status' : undefined}
      className={`lp-banner ${styles.banner}`}
      data-tone={tone}
      data-testid={testId}
      // Step 12 text on the step-3 tint: step 11 there is ~4.2:1 for amber (spec §7: 4.5:1 in both themes).
      style={{ background: `var(--${tone}-a3)`, color: `var(--${tone}-12)` }}
    >
      <Icon size={16} aria-hidden style={{ flex: 'none' }} />
      <span className={styles.bannerText}>{children}</span>
      {action ? (
        <Button
          size="1"
          variant="soft"
          color={tone}
          highContrast
          className={`${styles.bannerAction} lp-hit`}
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

// How many views placed their own ConnectionBanner (the shell's copy shows only while none did).
const placed = { count: 0, listeners: new Set<() => void>() };
const subscribePlaced = (l: () => void) => {
  placed.listeners.add(l);
  return () => {
    placed.listeners.delete(l);
  };
};
const readPlaced = () => placed.count;
const readPlacedServer = () => 0;
const bumpPlaced = (delta: number) => {
  placed.count += delta;
  for (const l of [...placed.listeners]) l();
};

export interface ConnectionBannerProps {
  /** 'shell' is the app shell's fallback copy; views leave the default. */
  placement?: 'shell' | 'view';
  /**
   * The view's live status (useLiveStatus()), shared with its line and badge. Without it (the profile, the
   * shell) the banner reads the store's own.
   */
  status?: LiveLine;
}

/** Amber "Reconnecting…", gray "Offline · N waiting to send", or nothing while healthy. */
export function ConnectionBanner({ placement = 'view', status }: ConnectionBannerProps) {
  return status ? <StateBanner state={status.state} placement={placement} /> : <StoreBanner placement={placement} />;
}

function StoreBanner({ placement }: { placement: 'shell' | 'view' }) {
  const status = useLiveStatus();
  return <StateBanner state={status.state} placement={placement} />;
}

function StateBanner({ state, placement }: { state: LiveState; placement: 'shell' | 'view' }) {
  const outbox = useOutbox();
  const placedByViews = useSyncExternalStore(subscribePlaced, readPlaced, readPlacedServer);

  useLayoutEffect(() => {
    if (placement !== 'view') return;
    bumpPlaced(1);
    return () => bumpPlaced(-1);
  }, [placement]);

  // The live region speaks when the state changes while this banner is mounted, not when it first appears.
  const [spoken, setSpoken] = useState<{ state: LiveState; text: string }>({ state, text: '' });
  if (spoken.state !== state) setSpoken({ state, text: liveAnnouncement(spoken.state, state) ?? '' });

  if (placement === 'shell' && placedByViews > 0) return null;
  const cue = stateCue(state, outbox.length);
  const banner =
    cue.banner && cue.tone !== 'green' ? (
      <Banner tone={cue.tone} icon={state === 'offline' ? 'offline' : 'reconnecting'} live={false} testId="connection-banner">
        {cue.banner}
      </Banner>
    ) : null;
  return (
    <>
      {/* The shell's copy sits at the very top of the page: clear the status bar / notch. */}
      {banner && placement === 'shell' ? <div className={styles.shellBanner}>{banner}</div> : banner}
      <VisuallyHidden role="status" data-testid="live-announcement">
        {spoken.text}
      </VisuallyHidden>
    </>
  );
}
