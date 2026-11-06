'use client';
// The large page title is the view menu (polish-v7.html LogTitle; view-menu.png): "All requests" 28/700,
// its count in tertiary grey, a small chevron. The menu lists All requests, a divider, Pending (inbox) and
// My requests (person), each with its count and the current one filled and checked. Every view uses the
// same title ("Pending 4 ⌄"); the menu is how you get back to All (no separate × or "Newest first").
import { DropdownMenu, Skeleton, Text } from '@radix-ui/themes';
import { Check, ChevronDown, Inbox, List, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ViewCounts } from '@/lib/client/selectors';
import s from './list.module.css';

export type ListViewName = 'all' | 'pending' | 'mine';

export interface ViewSwitcherProps {
  view: ListViewName;
  /** null while loading (the count shows a placeholder). */
  counts: ViewCounts | null;
  onSelect: (view: ListViewName) => void;
}

export const VIEWS = {
  all: { title: 'All requests', Icon: List },
  pending: { title: 'Pending', Icon: Inbox },
  mine: { title: 'My requests', Icon: UserRound },
} as const;

const ORDER = ['all', 'pending', 'mine'] as const;

/** The switcher's name starts with what it shows, "Pending 4" (WCAG 2.5.3), then what it does. */
export function switcherLabel(title: string, count: number | null): string {
  return count === null ? `${title}, change view` : `${title} ${count}, change view`;
}

export function ViewSwitcher({ view, counts, onSelect }: ViewSwitcherProps) {
  const { title } = VIEWS[view];
  return (
    <h1 className={s.h1}>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <button
            type="button"
            className={s.ttl}
            aria-label={switcherLabel(title, counts ? counts[view] : null)}
            data-testid="view-switcher"
          >
            <span className={s.ttx}>{title}</span>{' '}
            {counts ? (
              <span className={s.tcount}>{counts[view]}</span>
            ) : (
              <Skeleton width="34px" height="24px" style={{ borderRadius: 6, alignSelf: 'center' }} />
            )}
            <span className={s.tchev}>
              <ChevronDown size={18} strokeWidth={2.25} aria-hidden />
            </span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="start" sideOffset={6} variant="soft" size="2" className={s.vmenu} aria-label="Show requests">
          {ORDER.map((v) => {
            const { title: itemTitle, Icon: ItemIcon } = VIEWS[v];
            const on = v === view;
            return (
              <ViewItemFragment key={v} separator={v === 'pending'}>
                <DropdownMenu.Item className={s.vitem} role="menuitemradio" aria-checked={on} onSelect={() => onSelect(v)}>
                  <span className={s.vic} aria-hidden>
                    <ItemIcon size={17} strokeWidth={1.75} />
                  </span>
                  <Text size="2" weight="medium" className={s.vtx}>
                    {itemTitle}
                  </Text>
                  {counts ? (
                    <Text size="2" color="gray" className={s.vcount}>
                      {counts[v]}
                    </Text>
                  ) : null}
                  <span className={s.vchk} aria-hidden>
                    {on ? <Check size={16} strokeWidth={1.75} /> : null}
                  </span>
                </DropdownMenu.Item>
              </ViewItemFragment>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </h1>
  );
}

function ViewItemFragment({ separator, children }: { separator: boolean; children: ReactNode }) {
  return (
    <>
      {separator ? <DropdownMenu.Separator className={s.vsep} /> : null}
      {children}
    </>
  );
}
