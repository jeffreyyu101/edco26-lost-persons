'use client';
// Small client hooks for the list views.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useActions, useConnection, type MutationResult } from '@/lib/client/store-contract';
import type { SettableStatus, StatusKind } from '@/lib/domain';

/** `flag`, but only once it has stayed true for `delayMs` (no flicker for fast background polls). */
export function useDelayedFlag(flag: boolean, delayMs: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!flag) return;
    const timer = setTimeout(() => setLate(true), delayMs);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [flag, delayMs]);
  return flag && late;
}

// Scroll positions of the list views, by history depth and view, for this page load. Going back from a
// profile restores the list where it was; switching views starts at the top (or where that view was).
const positions = new Map<string, number>();

function historyDepth(): number {
  const state = (window.history.state ?? {}) as { lpDepth?: unknown };
  return typeof state.lpDepth === 'number' ? state.lpDepth : 0;
}

/** Restores and remembers the window scroll for a list view once its data is on screen. */
export function useScrollMemory(viewKey: string, ready: boolean): void {
  useLayoutEffect(() => {
    if (!ready) return;
    const key = `${historyDepth()}|${viewKey}`;
    window.scrollTo(0, positions.get(key) ?? 0);
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        positions.set(key, window.scrollY);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [viewKey, ready]);
}

/**
 * Keeps `--lp-sticky-h` on the view's root at the height of its sticky header (title, banner, chips), so the
 * log's column header, which lives inside the log grid to share its columns, sticks right under it.
 */
export function useStickyHeight(): { rootRef: RefObject<HTMLDivElement | null>; stickyRef: RefObject<HTMLDivElement | null> } {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const sticky = stickyRef.current;
    if (!root || !sticky) return;
    const apply = () => root.style.setProperty('--lp-sticky-h', `${sticky.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(apply);
    observer.observe(sticky);
    return () => observer.disconnect();
  }, []);
  return { rootRef, stickyRef };
}

/**
 * (F3 + F4 release) Keeps the CSS variable `name` on `rootRef`'s element at the height of the returned ref's
 * element (0 while it is not rendered): the desk's alerts banner (--lp-alerts-h), which the Pending board
 * subtracts from the window so the page never scrolls.
 */
export function useHeightVar(rootRef: RefObject<HTMLDivElement | null>, name: string): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const el = ref.current;
    if (!root) return;
    if (!el) {
      root.style.removeProperty(name);
      return;
    }
    const apply = () => root.style.setProperty(name, `${el.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty(name);
    };
  });
  return ref;
}

/**
 * iOS only opens the keyboard for a focus() made inside the tap itself, and the search field mounts a
 * moment later (a new view). Focusing a throwaway input during the tap opens the keyboard; the search
 * field then takes focus from it on mount and the keyboard stays up.
 */
export function primeKeyboard(): void {
  if (typeof document === 'undefined') return;
  const proxy = document.createElement('input');
  proxy.type = 'text';
  proxy.setAttribute('aria-hidden', 'true');
  proxy.tabIndex = -1;
  proxy.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0;pointer-events:none;';
  document.body.appendChild(proxy);
  proxy.focus({ preventScroll: true });
  setTimeout(() => proxy.remove(), 1_000);
}

/**
 * A status tap from a list card (Not in medical / In medical / Reunited). The store owns the overlay, the
 * Undo snackbar and every failure toast. Offline (status changes are not queued in v1) the buttons look
 * disabled and a tap explains why instead (and returns null). Otherwise the store's result, for a screen
 * that follows up on the answer (the location sheet after In medical).
 */
export function useStatusTap(): {
  offline: boolean;
  tap: (id: string, to: SettableStatus, kind: StatusKind) => Promise<MutationResult> | null;
} {
  const actions = useActions();
  const { connection } = useConnection();
  const offline = connection === 'offline';
  const tap = useCallback(
    (id: string, to: SettableStatus, kind: StatusKind) => {
      if (offline) {
        actions.showToast({ tone: 'amber', icon: 'cloud-off', title: 'Needs a connection', durationMs: 3_000 });
        return null;
      }
      return actions.setStatus(id, to, kind);
    },
    [actions, offline],
  );
  return { offline, tap };
}
