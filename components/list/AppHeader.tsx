'use client';
// List-view header (design/screens/polish-v7.html LogTitle, v7-log.png): the large title is the view menu
// ("All requests 13 ⌄"), then search, the Activity bell (F4, components/activity) and the avatar (account
// menu, owned by components/account, which also opens the Alerts sheet). There is no live dot while the app is live (2026-11-06 header declutter): only
// while it is offline or reconnecting does a small badge sit on the avatar, like a presence dot, amber with a
// crossed-out cloud when offline, red with a turning arrow while it can't reach the log. It takes no room
// from the title, and the banner under the header says the same in words (with Try again).
import { CloudOff, RefreshCw, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { ActivityBell } from '@/components/activity/ActivityBell';
import type { ViewCounts } from '@/lib/client/selectors';
import type { Connection } from '@/lib/client/store-contract';
import { ViewSwitcher, type ListViewName } from './ViewSwitcher';
import s from './list.module.css';

export interface AppHeaderProps {
  view: ListViewName;
  /** null while loading (the count shows a placeholder). */
  counts: ViewCounts | null;
  /** The view menu picked a view. */
  onSelect: (view: ListViewName) => void;
  connection: Connection;
  /** A sync is in flight (while the log can't be reached, the badge's arrow turns: reconnecting). */
  syncing: boolean;
  /** Opens search (the field takes over the header): navigate({q: ''}). */
  onOpenSearch: () => void;
  /** The avatar + menu, i.e. <AccountMenu />. */
  account: ReactNode;
}

const DOWN_LABEL: Readonly<Record<Exclude<Connection, 'live'>, string>> = {
  offline: 'Offline',
  error: "Can't reach the log",
};

/** The offline / reconnecting badge on the avatar. Nothing when live. */
export function ConnectionIndicator({ connection, syncing }: Pick<AppHeaderProps, 'connection' | 'syncing'>) {
  if (connection === 'live') return null;
  const reconnecting = connection === 'error' && syncing;
  return (
    <span
      className={s.conn}
      role="img"
      data-state={connection}
      data-syncing={reconnecting ? '' : undefined}
      aria-label={reconnecting ? 'Reconnecting' : DOWN_LABEL[connection]}
      data-testid="connection-indicator"
    >
      {connection === 'offline' ? (
        <CloudOff size={10} strokeWidth={2.5} aria-hidden />
      ) : (
        <RefreshCw size={9} strokeWidth={2.75} aria-hidden className={s.connSpin} />
      )}
    </span>
  );
}

export function AppHeader({ view, counts, onSelect, connection, syncing, onOpenSearch, account }: AppHeaderProps) {
  return (
    <header className={s.top}>
      <ViewSwitcher view={view} counts={counts} onSelect={onSelect} />
      <div className={s.icons}>
        <button type="button" className={s.ib} aria-label="Search" onClick={onOpenSearch}>
          <Search size={20} strokeWidth={1.75} aria-hidden />
        </button>
        <ActivityBell place="phone" />
        <span className={s.avatar}>
          {account}
          <ConnectionIndicator connection={connection} syncing={syncing} />
        </span>
      </div>
    </header>
  );
}
