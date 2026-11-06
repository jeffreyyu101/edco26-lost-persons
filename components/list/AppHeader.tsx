'use client';
// List-view header (requests.html .top): the title "Is my friend in medical?", the live dot (tap to sync
// now; amber offline or when the log can't be reached, grey while loading), then search, the bell and the
// avatar (account menu, owned by components/account).
import { Flex, Heading, IconButton } from '@radix-ui/themes';
import { BellOff, BellRing, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Connection } from '@/lib/client/store-contract';
import s from './list.module.css';

export interface AppHeaderProps {
  connection: Connection;
  /** A sync is in flight: the dot is grey. */
  syncing: boolean;
  /** Tap the live dot. */
  onSyncNow: () => void;
  /** Opens search (the field takes over the header): navigate({q: ''}). */
  onOpenSearch: () => void;
  /** New-request alerts. */
  bellOn: boolean;
  onToggleBell: () => void;
  /** The avatar + menu, i.e. <AccountMenu />. */
  account: ReactNode;
}

export type LiveState = 'live' | 'off' | 'loading';

export function liveState(connection: Connection, syncing: boolean): LiveState {
  if (syncing) return 'loading';
  return connection === 'live' ? 'live' : 'off';
}

const LIVE_LABEL: Readonly<Record<Connection, string>> = {
  live: 'Live. Tap to sync now',
  offline: 'Offline. Tap to try again',
  error: "Can't reach the log. Tap to try again",
};

const ICON = { size: 18, strokeWidth: 1.75, 'aria-hidden': true } as const;

export function AppHeader({ connection, syncing, onSyncNow, onOpenSearch, bellOn, onToggleBell, account }: AppHeaderProps) {
  const state = liveState(connection, syncing);
  return (
    <header className={s.top}>
      <div className={s.title}>
        <Heading as="h1" size="3" weight="medium" className={s.heading}>
          Is my friend in medical?
        </Heading>
        <button
          type="button"
          className={s.liveBtn}
          onClick={onSyncNow}
          aria-label={syncing ? 'Syncing' : LIVE_LABEL[connection]}
          data-testid="live-dot"
          data-state={state}
        >
          <span className={s.live} data-state={state} />
        </button>
      </div>
      <Flex align="center" gap="4" flexShrink="0">
        <IconButton className={s.hit} variant="ghost" color="gray" aria-label="Search" onClick={onOpenSearch}>
          <Search {...ICON} />
        </IconButton>
        <IconButton
          className={s.hit}
          variant={bellOn ? 'soft' : 'ghost'}
          color="gray"
          highContrast={bellOn}
          // A toggle: the name stays fixed and aria-pressed carries the state.
          aria-label="New-request alerts"
          aria-pressed={bellOn}
          onClick={onToggleBell}
        >
          {bellOn ? <BellRing {...ICON} /> : <BellOff {...ICON} />}
        </IconButton>
        {account}
      </Flex>
    </header>
  );
}
