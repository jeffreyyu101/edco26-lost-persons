'use client';
// List-view header (design/screens/polish-v7.html LogTitle, v7-log.png): the large title is the view menu
// ("All requests 13 ⌄"), then search, the Activity bell (F4, components/activity) and the avatar (account
// menu, owned by components/account, which also opens the Alerts sheet). There is no live dot while the app
// is healthy (2026-11-06 header declutter): only while it is offline or reconnecting does a small badge sit on
// the avatar, like a presence dot, gray with a crossed-out cloud when offline, amber with a still arrow while
// reconnecting (the banner's colours). It takes no room from the title, and its state is the view's live
// status, the one the banner and the line show.
import { CloudOff, RefreshCw, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { ActivityBellSlot } from '@/components/activity/slots';
import { stateCue, type LiveState } from '@/lib/client/live-status';
import type { ViewCounts } from '@/lib/client/selectors';
import { ViewSwitcher, type ListViewName } from './ViewSwitcher';
import s from './list.module.css';

export interface AppHeaderProps {
  view: ListViewName;
  /** null while loading (the count shows a placeholder). */
  counts: ViewCounts | null;
  /** The view menu picked a view. */
  onSelect: (view: ListViewName) => void;
  /** The view's live status (useLiveStatus().state). */
  state: LiveState;
  /** Opens search (the field takes over the header): navigate({q: ''}). */
  onOpenSearch: () => void;
  /** The avatar + menu, i.e. <AccountMenu />. */
  account: ReactNode;
}

/** The offline / reconnecting badge on the avatar. Nothing while healthy. */
export function ConnectionIndicator({ state }: Pick<AppHeaderProps, 'state'>) {
  const { badge } = stateCue(state);
  if (!badge) return null;
  return (
    <span className={s.conn} role="img" data-state={state} aria-label={badge} data-testid="connection-indicator">
      {state === 'offline' ? <CloudOff size={10} strokeWidth={2.5} aria-hidden /> : <RefreshCw size={9} strokeWidth={2.75} aria-hidden />}
    </span>
  );
}

export function AppHeader({ view, counts, onSelect, state, onOpenSearch, account }: AppHeaderProps) {
  return (
    <header className={s.top}>
      <ViewSwitcher view={view} counts={counts} onSelect={onSelect} />
      <div className={s.icons}>
        <button type="button" className={s.ib} aria-label="Search" onClick={onOpenSearch}>
          <Search size={20} strokeWidth={1.75} aria-hidden />
        </button>
        <ActivityBellSlot place="phone" />
        <span className={s.avatar}>
          {account}
          <ConnectionIndicator state={state} />
        </span>
      </div>
    </header>
  );
}
