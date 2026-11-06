'use client';
// The list title is a view switcher (requests.html .vbar / .vsw / .vmenu, view-menu.png): All requests,
// a divider, Pending (inbox) and My requests (person), each with its count and a check on the current one.
// On All the right side reads "Newest first"; in Pending / My requests a × returns to All. Anything passed
// as children (the filter chips) renders under the switcher, above the bar's bottom border.
import { DropdownMenu, IconButton, Skeleton, Text } from '@radix-ui/themes';
import { Check, ChevronDown, Inbox, List, UserRound, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ViewCounts } from '@/lib/client/selectors';
import s from './list.module.css';

export type ListViewName = 'all' | 'pending' | 'mine';

export interface ViewSwitcherProps {
  view: ListViewName;
  /** null while loading (the count shows a placeholder). */
  counts: ViewCounts | null;
  onSelect: (view: ListViewName) => void;
  /** Rendered under the switcher row (filter chips). */
  children?: ReactNode;
}

export const VIEWS = {
  all: { title: 'All requests', Icon: List },
  pending: { title: 'Pending', Icon: Inbox },
  mine: { title: 'My requests', Icon: UserRound },
} as const;

const ORDER = ['all', 'pending', 'mine'] as const;

export function ViewSwitcher({ view, counts, onSelect, children }: ViewSwitcherProps) {
  const { title, Icon } = VIEWS[view];
  return (
    <div className={s.vbar}>
      <div className={s.vrow}>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <button type="button" className={s.vsw} aria-label={`Showing ${title}. Change`} data-testid="view-switcher">
              <Icon size={16} strokeWidth={1.75} aria-hidden />
              <span className={s.vtitle}>{title}</span>
              {counts ? (
                <span className={s.vc}>{counts[view]}</span>
              ) : (
                <Skeleton width="18px" height="12px" style={{ borderRadius: 4 }} />
              )}
              <ChevronDown size={15} strokeWidth={1.75} aria-hidden />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content
            align="start"
            sideOffset={6}
            variant="soft"
            size="2"
            className={s.vmenu}
            aria-label="Show requests"
          >
            {ORDER.map((v) => {
              const { title: itemTitle, Icon: ItemIcon } = VIEWS[v];
              const on = v === view;
              return (
                <ViewItemFragment key={v} separator={v === 'pending'}>
                  <DropdownMenu.Item
                    className={s.vitem}
                    role="menuitemradio"
                    aria-checked={on}
                    onSelect={() => onSelect(v)}
                  >
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
        <span className={s.sp} />
        {counts === null ? null : view === 'all' ? (
          <Text size="1" color="gray">
            Newest first
          </Text>
        ) : (
          <IconButton
            className={s.hit}
            size="1"
            variant="ghost"
            color="gray"
            aria-label="Back to all requests"
            onClick={() => onSelect('all')}
          >
            <X size={15} strokeWidth={1.75} aria-hidden />
          </IconButton>
        )}
      </div>
      {children}
    </div>
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
