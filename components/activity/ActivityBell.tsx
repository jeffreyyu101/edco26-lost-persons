'use client';
// The Activity bell (design/screens/f34-states.html, f34-v2-1 and 9): an IconButton next to search on every
// main view, with a monochrome count (hidden at 0, then 1–9, "9+"); "Activity, 3 unread" for screen readers.
//   * Phone (< 768 px, place "phone", in the list header): opens a tall sheet (Radix Dialog) with a strip of
//     dimmed page above it (a tap there closes it), ✕ in its header, and a swipe down from its grabber or
//     header (or its list scrolled to the top) closes it; focus goes back to the bell.
//   * Desk (place "desk", in the top bar): a Popover anchored to the bell, 380 wide, at most 480 tall. The
//     sidebar's Activity item (ActivityNavItem) and the rail's (DeskRailActivity) open the same popover.
//     Opened from any of them, focus moves into the popover (it is portalled to the end of the page, so Tab
//     would never reach it otherwise): Tab goes on to Mark all read and the rows; Escape gives focus back to
//     whatever opened it.
// The open state is shared (lib/client/activity-client.ts), so the bell and the sidebar item are one control.
import { Dialog, IconButton, Popover, VisuallyHidden } from '@radix-ui/themes';
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentPropsWithRef, type ReactElement } from 'react';
import { useInDesk } from '@/components/desk/desk-context';
import { useSheetSwipe } from '@/components/ui/use-sheet-swipe';
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
 * The phone's sheet, named by its visible "Activity" heading, opened by the bell (its trigger, so focus goes back
 * to it). ✕ "Close Activity" (focused when it opens), Escape, the strip of scrim above it and a swipe down close
 * it; the grabber is only something to drag.
 */
function ActivitySheet({ open, onOpenChange, bell }: { open: boolean; onOpenChange: (open: boolean) => void; bell: ReactElement }) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  useSheetSwipe(node, () => onOpenChange(false));
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger>{bell}</Dialog.Trigger>
      <Dialog.Content
        ref={setNode}
        className={`lp-activity-sheet ${s.sheet}`}
        aria-describedby={undefined}
        data-testid="activity-sheet"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          close.current?.focus();
        }}
      >
        <div className={`${s.handle} lp-hit`} aria-hidden data-sheet-grab="" data-testid="activity-grabber" />
        <div className={s.sheetScroll}>
          <ActivityPanel
            variant="sheet"
            onClose={() => onOpenChange(false)}
            heading={({ className, children }) => (
              <Dialog.Title className={className} as="h2">
                {children}
              </Dialog.Title>
            )}
            headEnd={
              <Dialog.Close>
                <IconButton ref={close} variant="ghost" color="gray" size="3" className={s.close} aria-label="Close Activity" data-testid="activity-close">
                  <X size={20} strokeWidth={2} aria-hidden />
                </IconButton>
              </Dialog.Close>
            }
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
  /** What had focus when the popover opened (the bell, the sidebar or the rail item): Escape returns there. */
  const opener = useRef<HTMLElement | null>(null);
  /** It closed because of a click or focus outside: focus stays where the person put it. */
  const outside = useRef(false);
  // In the desk the list header is hidden phone chrome: the top bar's bell is the one.
  if (place === 'phone' && inDesk) return null;
  if (place === 'phone') {
    return <ActivitySheet open={activity.open} onOpenChange={(o) => client.setOpen(o)} bell={<BellButton unread={activity.unread} />} />;
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
        onOpenAutoFocus={(e) => {
          // The panel itself takes focus (not Mark all read: its tooltip would show), so the next Tab reaches
          // Mark all read and the rows.
          e.preventDefault();
          outside.current = false;
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          (e.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
        }}
        onInteractOutside={() => {
          outside.current = true;
        }}
        onCloseAutoFocus={(e) => {
          const back = opener.current;
          opener.current = null;
          if (!outside.current && back && back.isConnected && back !== document.body) {
            e.preventDefault();
            back.focus({ preventScroll: true });
          }
        }}
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
