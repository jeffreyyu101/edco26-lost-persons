'use client';
// Centered empty / error state (states.html: "No requests yet", "Can't reach the log" + Try again).
// STUB (Phase 1a): props are final.
import { Button, Text } from '@radix-ui/themes';
import { Inbox, Plug, RefreshCw, Search } from 'lucide-react';

export interface EmptyStateProps {
  icon: 'inbox' | 'plug' | 'search';
  title: string;
  action?: { label: string; onClick: () => void; icon?: 'refresh' };
}

const ICONS = { inbox: Inbox, plug: Plug, search: Search } as const;

export function EmptyState({ icon, title, action }: EmptyStateProps) {
  const Icon = ICONS[icon];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '48px 32px 80px', textAlign: 'center' }}>
      <span style={{ width: 56, height: 56, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--gray-a3)', color: 'var(--gray-11)' }}>
        <Icon size={24} aria-hidden />
      </span>
      <Text size="3" weight="medium">
        {title}
      </Text>
      {action ? (
        <Button size="3" variant="soft" color="gray" highContrast onClick={action.onClick}>
          {action.icon === 'refresh' ? <RefreshCw size={16} aria-hidden /> : null}
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
