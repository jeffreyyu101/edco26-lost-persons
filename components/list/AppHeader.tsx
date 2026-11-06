'use client';
// List-view header (requests.html .top): the title "Is my friend in medical?", the live dot (tap to sync
// now; amber offline, grey while loading), then search, the bell and the avatar (account menu).
// STUB (Phase 1a): props are final; L (Phase 2) ports the mockup exactly.
import { Flex, Heading, IconButton } from '@radix-ui/themes';
import { Bell, BellOff, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Connection } from '@/lib/client/store-contract';

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

export function AppHeader({ connection, syncing, onSyncNow, onOpenSearch, bellOn, onToggleBell, account }: AppHeaderProps) {
  const dot = syncing ? 'var(--gray-9)' : connection === 'live' ? 'var(--green-9)' : 'var(--amber-9)';
  const dotLabel = syncing ? 'Syncing' : connection === 'live' ? 'Live. Tap to sync now' : connection === 'offline' ? 'Offline. Tap to retry' : "Can't reach the log. Tap to retry";
  return (
    <Flex align="center" justify="between" gap="3" px="4" pt="4" pb="3">
      <Flex align="center" gap="2" minWidth="0">
        <Heading size="3" weight="medium" truncate>
          Is my friend in medical?
        </Heading>
        <button
          type="button"
          onClick={onSyncNow}
          aria-label={dotLabel}
          style={{ border: 0, background: 'none', padding: 10, margin: -10, display: 'grid', placeItems: 'center', cursor: 'pointer' }}
        >
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot }} />
        </button>
      </Flex>
      <Flex align="center" gap="4" flexShrink="0">
        <IconButton variant="ghost" color="gray" aria-label="Search" onClick={onOpenSearch}>
          <Search size={18} aria-hidden />
        </IconButton>
        <IconButton
          variant={bellOn ? 'soft' : 'ghost'}
          color="gray"
          highContrast={bellOn}
          aria-label={bellOn ? 'New-request alerts on' : 'New-request alerts off'}
          aria-pressed={bellOn}
          onClick={onToggleBell}
        >
          {bellOn ? <Bell size={18} aria-hidden /> : <BellOff size={18} aria-hidden />}
        </IconButton>
        {account}
      </Flex>
    </Flex>
  );
}
