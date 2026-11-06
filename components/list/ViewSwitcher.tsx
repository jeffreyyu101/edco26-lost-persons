'use client';
// The list title is a view switcher (requests.html .vbar / .vmenu): All requests, a divider, Pending
// (inbox) and My requests (person), each with its count. In Pending / My requests a × returns to All.
// STUB (Phase 1a): props are final; L (Phase 2) ports the mockup menu.
import { DropdownMenu, IconButton, Text } from '@radix-ui/themes';
import { ChevronDown, Inbox, List, User, X } from 'lucide-react';
import type { ViewCounts } from '@/lib/client/selectors';

export type ListViewName = 'all' | 'pending' | 'mine';

export interface ViewSwitcherProps {
  view: ListViewName;
  /** null while loading (the count shows a placeholder). */
  counts: ViewCounts | null;
  onSelect: (view: ListViewName) => void;
}

const VIEWS = {
  all: { title: 'All requests', Icon: List },
  pending: { title: 'Pending', Icon: Inbox },
  mine: { title: 'My requests', Icon: User },
} as const;

export function ViewSwitcher({ view, counts, onSelect }: ViewSwitcherProps) {
  const { title, Icon } = VIEWS[view];
  const count = (v: ListViewName) => (counts ? counts[v] : '–');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px 10px', borderBottom: '1px solid var(--gray-a3)' }}>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <button type="button" aria-label={`Showing ${title}. Change`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 9px 0 11px', borderRadius: 'var(--radius-3)', border: 0, background: 'var(--gray-a3)', color: 'var(--gray-12)', font: 'inherit', fontSize: 15, fontWeight: 500 }}>
            <Icon size={16} aria-hidden />
            <span>{title}</span>
            <span style={{ color: 'var(--gray-10)', fontWeight: 400 }}>{count(view)}</span>
            <ChevronDown size={15} aria-hidden />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          {(['all', 'pending', 'mine'] as const).map((v, i) => (
            <div key={v}>
              {i === 1 ? <DropdownMenu.Separator /> : null}
              <DropdownMenu.Item onSelect={() => onSelect(v)}>
                {VIEWS[v].title} · {count(v)}
              </DropdownMenu.Item>
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      <span style={{ flex: 1 }} />
      {view === 'all' ? (
        <Text size="1" color="gray">
          Newest first
        </Text>
      ) : (
        <IconButton size="1" variant="ghost" color="gray" aria-label="Back to all requests" onClick={() => onSelect('all')}>
          <X size={15} aria-hidden />
        </IconButton>
      )}
    </div>
  );
}
