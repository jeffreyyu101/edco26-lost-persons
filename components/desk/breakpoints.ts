'use client';
// Desk breakpoints (design/references/mobbin-desktop.txt rule 1, the Radix Themes sm / md / lg steps).
// Looks are CSS media queries in components/desk/*.module.css (SSR-safe, no layout flash). This hook is
// only for behaviour that changes at 768 px: what the one route renders (the list stays behind an open
// request, a form opens over the list) and the desk keyboard. Under 768 px the phone app is unchanged.
import { useSyncExternalStore } from 'react';

/** Phone below, desk (icon rail) from here: iPad portrait. */
export const DESK_MIN = 768;
/** A request docks as a 420 px panel instead of a 480 px sheet: iPad landscape, small laptops. */
export const DOCK_MIN = 1024;
/** The 232 px sidebar replaces the icon rail and the docked panel is 452 px. */
export const SIDEBAR_MIN = 1280;

export const DESK_QUERY = `(min-width: ${DESK_MIN}px)`;

export type DeskLayout = 'phone' | 'tablet' | 'laptop' | 'desktop';

/** The layout for a viewport width (CSS px), as the stylesheets apply it. */
export function layoutFor(width: number): DeskLayout {
  if (width >= SIDEBAR_MIN) return 'desktop';
  if (width >= DOCK_MIN) return 'laptop';
  if (width >= DESK_MIN) return 'tablet';
  return 'phone';
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia(DESK_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function snapshot(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(DESK_QUERY).matches;
}

/** The server (and the hydration render) is always the phone: views are client-only chunks anyway. */
const serverSnapshot = () => false;

/** true from 768 px. Re-renders when the window crosses the breakpoint (rotation, resize). */
export function useIsDesk(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/** The same test outside React (event handlers, the offline prefetch). */
export function isDeskNow(): boolean {
  return snapshot();
}
