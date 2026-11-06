'use client';
// Inline status banner (states.html .bnr — "Offline · 2 waiting to send", "Can't reach the log · Try
// again", "Updated by someone else", "Update ready · Reload").
//
// ConnectionBanner is the connected offline / error banner. The shell renders one at the top of every view;
// a view that wants it where the mockup puts it (lists: between the header and the view switcher; the form:
// under its top bar) renders <ConnectionBanner /> there, and the shell's copy then steps aside.
import { Button } from '@radix-ui/themes';
import { CircleAlert, CloudOff, Plug, RefreshCw } from 'lucide-react';
import { useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useActions, useConnection, useOutbox } from '@/lib/client/store-contract';
import styles from './ui.module.css';

export type BannerTone = 'amber' | 'red' | 'gray' | 'blue';
export type BannerIcon = 'offline' | 'error' | 'conflict' | 'update';

const ICONS = { offline: CloudOff, error: Plug, conflict: CircleAlert, update: RefreshCw } as const;

export interface BannerProps {
  tone: BannerTone;
  icon: BannerIcon;
  children: ReactNode;
  action?: { label: string; onClick: () => void; disabled?: boolean };
}

export function Banner({ tone, icon, children, action }: BannerProps) {
  const Icon = ICONS[icon];
  return (
    <div
      role="status"
      className={`lp-banner ${styles.banner}`}
      data-tone={tone}
      style={{ background: `var(--${tone}-a3)`, color: `var(--${tone}-11)` }}
    >
      <Icon size={16} aria-hidden style={{ flex: 'none' }} />
      <span className={styles.bannerText}>{children}</span>
      {action ? (
        <Button size="1" variant="soft" color={tone} className={styles.bannerAction} onClick={action.onClick} disabled={action.disabled}>
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
}

/** "Offline · N waiting to send" (amber) or "Can't reach the log" + Try again (red); nothing when live. */
export function ConnectionBanner({ placement = 'view' }: ConnectionBannerProps) {
  const { connection } = useConnection();
  const outbox = useOutbox();
  const actions = useActions();
  const placedByViews = useSyncExternalStore(subscribePlaced, readPlaced, readPlacedServer);

  useLayoutEffect(() => {
    if (placement !== 'view') return;
    bumpPlaced(1);
    return () => bumpPlaced(-1);
  }, [placement]);

  if (placement === 'shell' && placedByViews > 0) return null;
  if (connection === 'offline') {
    return (
      <Banner tone="amber" icon="offline">
        Offline · {outbox.length} waiting to send
      </Banner>
    );
  }
  if (connection === 'error') {
    return (
      <Banner tone="red" icon="error" action={{ label: 'Try again', onClick: actions.syncNow }}>
        Can&apos;t reach the log
      </Banner>
    );
  }
  return null;
}
