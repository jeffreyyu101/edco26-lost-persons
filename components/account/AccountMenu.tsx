'use client';
// Avatar + account menu (states.html AccountMenu): name and short team, Theme (Light / Dark / Auto),
// Dashboard, Export CSV (new tab in an iOS standalone app), Sign out (refused while the outbox has unsent
// items, with an explicit discard option), and "Built by Jeffrey Yu". Self-contained: reads the store.
// STUB (Phase 1a): the exported name and props are FINAL; P (Phase 2) builds the real menu.
import { Avatar, DropdownMenu, Text } from '@radix-ui/themes';
import { navigate } from '@/lib/client/nav';
import { useActions, usePrefs, useSession } from '@/lib/client/store-contract';
import { avatarInitials, teamShort } from '@/lib/domain';
import { applyTheme } from '@/lib/theme';

export interface AccountMenuProps {
  /** Radix avatar size for the trigger (header uses "2"). */
  size?: '2' | '3';
}

export function AccountMenu({ size = '2' }: AccountMenuProps) {
  const session = useSession();
  const prefs = usePrefs();
  const actions = useActions();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <button type="button" aria-label="Account" style={{ border: 0, background: 'none', padding: 0, borderRadius: '50%' }}>
          <Avatar size={size} radius="full" variant="solid" color="gray" highContrast fallback={avatarInitials(session.staffName) || '?'} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <DropdownMenu.Label>
          <Text size="2" weight="medium">
            {session.staffName} · {teamShort(session.team ?? '')}
          </Text>
        </DropdownMenu.Label>
        {(['light', 'dark', 'auto'] as const).map((t) => (
          <DropdownMenu.Item
            key={t}
            onSelect={() => {
              applyTheme(t);
              actions.setPref('theme', t);
            }}
          >
            {t === 'light' ? 'Light' : t === 'dark' ? 'Dark' : 'Auto'}
            {prefs.theme === t ? ' ✓' : ''}
          </DropdownMenu.Item>
        ))}
        <DropdownMenu.Item onSelect={() => navigate({ dashboard: true })}>Dashboard</DropdownMenu.Item>
        <DropdownMenu.Item onSelect={() => void actions.signOut()}>Sign out</DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Label>
          <Text size="1" color="gray">
            Built by Jeffrey Yu
          </Text>
        </DropdownMenu.Label>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
