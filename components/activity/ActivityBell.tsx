'use client';
// The Activity bell (design/screens/f34-states.html, f34-v2-1 and 9): an IconButton next to search on every
// main view, with a monochrome count (hidden at 0, then 1–9, "9+"); "Activity, 3 unread" for screen readers.
//   * Phone (< 768 px, place "phone", in the list header): opens a full-height sheet (Radix Dialog).
//   * Desk (place "desk", in the top bar): a Popover anchored to the bell, 380 wide, at most 480 tall. The
//     sidebar's Activity item (ActivityNavItem) and the rail's (ActivityRailItem) open the same popover.
// The open state is shared (lib/client/activity-client.ts), so the bell and the sidebar item are one control.
import { Dialog, IconButton, Popover, VisuallyHidden } from '@radix-ui/themes';
import { useEffect, type ComponentPropsWithRef } from 'react';
import { useInDesk } from '@/components/desk/desk-context';
import { badgeText } from '@/lib/activity';
import { activityClient, useActivity } from '@/lib/client/activity-client';
import { ActivityPanel } from './ActivityPanel';
import { BellIcon } from './icons';
import s from './activity.module.css';

/** "Activity, 3 unread" (or "Activity"). */
export function bellLabel(unread: number): string {
  return unread > 0 ? `Activity, ${unread} unread` : 'Activity';
}

function useStarted() {
  useEffect(() => activityClient().start(), []);
}

/**
 * The bell. Everything a Radix trigger passes (its ref above all: the popover is anchored to it, and React 19
 * hands refs to function components as a prop) goes on to the button.
 */
function BellButton({ unread, ...rest }: { unread: number } & Omit<ComponentPropsWithRef<typeof IconButton>, 'children'>) {
  const text = badgeText(unread);
  return (
    <IconButton
      {...rest}
      variant="ghost"
      color="gray"
      size="3"
      className={`${s.bell} lp-hit`}
      aria-label={bellLabel(unread)}
      data-testid="activity-bell"
      data-unread={unread}
    >
      <BellIcon size={20} strokeWidth={1.75} />
      {text ? (
        <span className={s.badge} aria-hidden data-testid="activity-badge">
          {text}
        </span>
      ) : null}
    </IconButton>
  );
}

/**
 * The phone's sheet: full height, named by its visible "Activity" heading. The grabber is its close button
 * (a tap, VoiceOver, Switch Control); Escape and the strip of scrim above it close it too.
 */
function ActivitySheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className={`lp-activity-sheet ${s.sheet}`} aria-describedby={undefined} data-testid="activity-sheet">
        <Dialog.Close>
          <button type="button" className={`${s.handle} lp-hit`} aria-label="Close Activity" data-testid="activity-close" />
        </Dialog.Close>
        <div className={s.sheetScroll}>
          <ActivityPanel
            variant="sheet"
            onClose={() => onOpenChange(false)}
            heading={({ className, children }) => (
              <Dialog.Title className={className} as="h2">
                {children}
              </Dialog.Title>
            )}
          />
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export interface ActivityBellProps {
  place: 'phone' | 'desk';
}

export function ActivityBell({ place }: ActivityBellProps) {
  useStarted();
  const activity = useActivity();
  const inDesk = useInDesk();
  const client = activityClient();
  // In the desk the list header is hidden phone chrome: the top bar's bell is the one.
  if (place === 'phone' && inDesk) return null;
  if (place === 'phone') {
    return (
      <>
        <BellButton unread={activity.unread} onClick={() => client.setOpen(true)} />
        <ActivitySheet open={activity.open} onOpenChange={(o) => client.setOpen(o)} />
      </>
    );
  }
  return (
    <Popover.Root open={activity.open} onOpenChange={(o) => client.setOpen(o)}>
      <Popover.Trigger>
        <BellButton unread={activity.unread} />
      </Popover.Trigger>
      <Popover.Content
        align="end"
        sideOffset={8}
        className={s.popover}
        aria-label="Activity"
        data-testid="activity-popover"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <ActivityPanel
          variant="popover"
          onClose={() => client.setOpen(false)}
          heading={({ className, children }) => (
            <h2 className={className}>{children}</h2>
          )}
        />
      </Popover.Content>
    </Popover.Root>
  );
}

/** The sidebar's Activity item, with the same count; it opens the top bar's popover. */
export function ActivityNavItem() {
  useStarted();
  const activity = useActivity();
  const text = badgeText(activity.unread);
  return (
    <button
      type="button"
      className={s.navItem}
      aria-haspopup="dialog"
      aria-expanded={activity.open}
      onClick={() => activityClient().setOpen(true)}
      data-testid="desk-activity"
    >
      <BellIcon size={16} strokeWidth={1.75} />
      {/* Named by what it shows, "Activity 3", then " unread" for screen readers (WCAG 2.5.3). */}
      <span className={s.navLabel}>Activity</span>{' '}
      {text ? (
        <>
          <span className={s.navBadge}>{text}</span>
          <VisuallyHidden> unread</VisuallyHidden>
        </>
      ) : null}
    </button>
  );
}
