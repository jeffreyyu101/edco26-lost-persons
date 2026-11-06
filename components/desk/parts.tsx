'use client';
// Small pieces shared by the sidebar, the rail and the top bar.
import type { MouseEvent, ReactNode } from 'react';
import { hrefFor, navigate, type NavParams } from '@/lib/client/nav';
import { useActions, useAllRows, useConnection, useCounts, useIsLoading, usePrefs, type Connection } from '@/lib/client/store-contract';
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

const LIVE_LABEL: Readonly<Record<Connection, string>> = {
  live: 'Live. Tap to sync now',
  offline: 'Offline. Tap to try again',
  error: "Can't reach the log. Tap to try again",
};

/**
 * The compact logo lockup at the top of the sidebar (EDC Orlando | Ground Control on the brand card's dark
 * gradient) or the rail (the two logos stacked on a square), with the phone header's live dot on its corner:
 * green live, amber offline or unreachable, grey while loading. Tap to sync now. The logos are decoration
 * here: the button is named by the live state.
 */
export function LiveMark({ variant, className }: { variant: 'side' | 'rail'; className?: string }) {
  const actions = useActions();
  const { connection } = useConnection();
  const loading = useIsLoading();
  const state = loading && connection === 'live' ? 'loading' : connection === 'live' ? 'live' : 'off';
  return (
    <button
      type="button"
      className={`${d.lockup} ${className ?? ''}`}
      onClick={actions.syncNow}
      aria-label={state === 'loading' ? 'Syncing' : LIVE_LABEL[connection]}
      data-testid="desk-live"
      data-variant={variant}
      data-state={state}
    >
      <img className={d.lockEdc} src="/logos/edc-orlando.png" alt="" width={194} height={132} decoding="async" draggable={false} />
      <span className={d.lockDiv} aria-hidden />
      <img className={d.lockGc} src="/logos/ground-control.png" alt="" width={313} height={120} decoding="async" draggable={false} />
      <span className={d.live} data-state={state} />
    </button>
  );
}

/** New-request alerts. The shell's host shows "Alerts are on" the first time it is switched on. */
export function useBell(): { on: boolean; toggle: () => void } {
  const actions = useActions();
  const prefs = usePrefs();
  return { on: prefs.bell, toggle: () => actions.setPref('bell', !prefs.bell) };
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
 * A tooltip with the control's label (hover and keyboard focus; not on touch screens). Decoration only:
 * the control carries its own accessible name. CSS-only, so no tooltip library on the first-load path.
 */
export function Tip({ children, below = false, end = false }: { children: string; below?: boolean; end?: boolean }) {
  return (
    <span className={d.tip} data-below={below ? '' : undefined} data-end={end ? '' : undefined} aria-hidden>
      {children}
    </span>
  );
}
