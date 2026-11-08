'use client';
// Small pieces shared by the sidebar and the top bar.
import type { MouseEvent, ReactNode } from 'react';
import { hrefFor, navigate, type NavParams } from '@/lib/client/nav';
import type { LiveState } from '@/lib/client/live-status';
import { useActions, useAllRows, useCounts, useIsLoading } from '@/lib/client/store-contract';
import { useLiveStatus } from '@/lib/client/use-live-status';
import type { MainView } from './views';
import d from './desk.module.css';

/** A link that changes the view in place (like the phone's view switcher: it replaces the entry). */
export function ViewLink({
  params,
  current,
  className,
  label,
  children,
}: {
  params: NavParams;
  current: boolean;
  className: string | undefined;
  label?: string;
  children: ReactNode;
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // A modified click keeps the browser's own behaviour (new tab, new window).
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(params, { replace: true });
  };
  return (
    <a href={hrefFor(params)} className={className} aria-current={current ? 'page' : undefined} aria-label={label} onClick={onClick}>
      {children}
    </a>
  );
}

/** The count next to the main view's title, or null (search, dashboard, still loading). */
export function useMainCount(view: MainView): number | null {
  const counts = useCounts();
  const loading = useIsLoading();
  const filter = view.name === 'all' ? view : { status: null, post: null, open: undefined };
  const filtered = view.name === 'all' && !!(view.status || view.post);
  const rows = useAllRows({ status: filter.status, post: filter.post, open: !!filter.open && !!filter.post });
  if (loading) return null;
  switch (view.name) {
    case 'all':
      return filtered ? rows.length : counts.all;
    case 'pending':
      return counts.pending;
    case 'mine':
      return counts.mine;
    default:
      return null;
  }
}

const LIVE_LABEL: Readonly<Record<LiveState, string>> = {
  healthy: 'Live. Tap to sync now',
  reconnecting: 'Reconnecting. Tap to try again',
  offline: 'Offline. Tap to try again',
};

/** The corner dot's state (desk.module.css .live): the line's colours, grey while nothing has loaded. */
const MARK_STATE: Readonly<Record<LiveState, string>> = { healthy: 'live', reconnecting: 'off', offline: 'offline' };

/** The collapsed sidebar's tooltip: the state in a word (the button's name says it in full). */
const MARK_TIP: Readonly<Record<string, string>> = { live: 'Live', off: 'Reconnecting', offline: 'Offline', loading: 'Syncing' };

/**
 * The logo lockup at the top of the sidebar (EDC Orlando | Ground Control on the brand card's dark gradient; the
 * EDC logo alone on a 32 px tile while the sidebar is collapsed), with a live dot on its corner. It reads the same
 * live status as the top bar's line and the banner (useLiveStatus, F1.2), so they never disagree: green while
 * healthy, amber while reconnecting, grey offline and while loading. Tap to sync now. The logos are decoration
 * here: the button is named by the live state.
 */
export function LiveMark() {
  const actions = useActions();
  const live = useLiveStatus();
  const loading = useIsLoading();
  const state = loading && live.state === 'healthy' ? 'loading' : MARK_STATE[live.state];
  return (
    <button
      type="button"
      className={d.lockup}
      onClick={actions.syncNow}
      aria-label={state === 'loading' ? 'Syncing' : LIVE_LABEL[live.state]}
      data-testid="desk-live"
    >
      <span className={d.lockArt}>
        {/* Easter egg (Brian, 2026-11-08): on hover with a mouse, a rainbow runs left to right through the white
            EDC Orlando logo, clipped to the logo's own shape (desk.module.css .lockRainbow). */}
        <span className={d.lockEdcWrap}>
          <img className={d.lockEdc} src="/logos/edc-orlando.png" alt="" width={194} height={132} decoding="async" draggable={false} />
          <span className={d.lockRainbow} aria-hidden data-testid="desk-live-rainbow" />
        </span>
        <span className={d.lockDiv} aria-hidden />
        <img className={d.lockGc} src="/logos/ground-control.png" alt="" width={313} height={120} decoding="async" draggable={false} />
      </span>
      <span className={d.live} data-state={state} />
      <Tip>{MARK_TIP[state] ?? 'Live'}</Tip>
    </button>
  );
}

/** A key cap, decoration only (the control carries aria-keyshortcuts). */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={`${d.kbd} ${className ?? ''}`} aria-hidden>
      {children}
    </kbd>
  );
}

/**
 * A tooltip with the control's label (hover and keyboard focus; not on touch screens): beside each item of the
 * collapsed sidebar, under a pane button. Decoration only: the control carries its own accessible name. CSS-only,
 * so no tooltip library on the first-load path.
 */
export function Tip({ children, below = false, end = false }: { children: string; below?: boolean; end?: boolean }) {
  return (
    <span className={d.tip} data-below={below ? '' : undefined} data-end={end ? '' : undefined} aria-hidden>
      {children}
    </span>
  );
}
