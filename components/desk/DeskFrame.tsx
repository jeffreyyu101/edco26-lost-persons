'use client';
// The desk frame (design/screens/desktop-log.html, desktop-new-tablet.html): rendered at every width and on
// the server, laid out only by CSS media queries (frame.module.css), so the columns are there from the
// first paint with no layout flash. Under 768 px every slot but the main content is display: none and the
// wrappers are plain blocks: the phone app renders exactly as before.
//
//   ≥ 768   [rail 60 | main]               a request opens as a 480 px sheet over the list (no scrim)
//   ≥ 1024  [rail 60 | main | pane 420]    the request docks on the right
//   ≥ 1280  [sidebar 232 | main | pane 452]
//
// On All requests the main column opens with Jeffrey's brand row (the `brand` slot, above the top bar): it
// scrolls away and the top bar stays. The app shell renders it from the server on, so it is in place at the
// first paint; under 768 px the slot is display: none and the shell drops it once hydrated (the phone's
// list draws its own row). The row's X has no handler of its own (the server drew it): the slot catches its
// click ([data-brand-hide]) and calls `onHideBrand`.
//
// The slot contents (sidebar / rail, top bar, pane header) come from the desk chunk
// (components/desk/DeskChrome.tsx), loaded only on the desk; this file stays tiny because it is on the
// first-load path of `/` (spec §7 Performance, the A25 budget).
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { DeskContext } from './desk-context';
import f from './frame.module.css';

const noSubscribe = () => () => {};
const brandInDocument = () => document.querySelector('[data-desk-main] > [data-testid="desk-brand"]') !== null;

/**
 * For the hydration render: whether the HTML being hydrated has the brand slot. Usually that is what the
 * server drew for this URL (`serverValue`), but the service worker keeps one copy of `/` (the last page it
 * fetched, whatever its query) and answers with it offline or on a stalled signal: /?dashboard=1 can get
 * the HTML drawn for All requests, card included, and / the HTML drawn for Pending, without it. Hydrating
 * what is really there keeps React from throwing away the page (error #418); the shell then shows or drops
 * the card as the view asks. Outside the hydration render it returns `serverValue` (unused there).
 */
export function useBrandInHtml(serverValue: boolean): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => serverValue,
    () => (typeof document === 'undefined' ? serverValue : brandInDocument()),
  );
}

export interface DeskFrameProps {
  /** From 768 px (useIsDesk). False on the server and in the hydration render. */
  desk: boolean;
  /** Sidebar + rail (both rendered; CSS shows one). */
  nav?: ReactNode;
  /** The brand row at the top of the main column, above the top bar (All requests only), or null. */
  brand?: ReactNode;
  /** The brand row's X: hide it on this device (prefs.brandHidden). */
  onHideBrand?: () => void;
  /** The main column's top bar. */
  top?: ReactNode;
  /** The detail pane (a request), or null when none is open. */
  pane?: ReactNode;
  /**
   * A form (new request, edit, needs attention) over the desk, or null. Drawn in place, it covers the main
   * column and the pane, which go inert. A form that portals its own dialog (the desk side sheet / modal)
   * leaves the layer empty: the layer then hides itself and the list stays visible behind the dialog,
   * whose own focus trap does the rest.
   */
  form?: ReactNode;
  /** The main column: a list or the dashboard on the desk, the whole view on the phone. */
  children: ReactNode;
}

/** True while `ref`'s element has child elements (a portalled dialog leaves it empty). */
function useOccupied(ref: RefObject<HTMLElement | null>, active: boolean): boolean {
  const [occupied, setOccupied] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) {
      setOccupied(false);
      return;
    }
    const update = () => setOccupied(el.childElementCount > 0);
    update();
    const observer = new MutationObserver(update);
    observer.observe(el, { childList: true });
    return () => observer.disconnect();
  }, [ref, active]);
  return occupied;
}

export function DeskFrame({ desk, nav = null, brand = null, onHideBrand, top = null, pane = null, form = null, children }: DeskFrameProps) {
  const formRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const covered = useOccupied(formRef, form !== null);
  const brandClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!onHideBrand || !(e.target instanceof Element) || !e.target.closest('[data-brand-hide]')) return;
    // The X is about to go: keyboard focus moves on to the top bar's title instead of falling back to the page.
    if (e.currentTarget.contains(document.activeElement)) {
      const title = topRef.current?.querySelector<HTMLElement>('h1');
      if (title) {
        title.tabIndex = -1;
        title.focus({ preventScroll: true });
      }
    }
    onHideBrand();
  };
  return (
    <DeskContext.Provider value={desk}>
      <div className={f.frame} data-desk={desk ? '' : undefined} data-pane={pane ? '' : undefined}>
        <div className={f.nav} inert={covered}>
          {nav}
        </div>
        <div className={f.main} data-desk-main="" inert={covered}>
          {brand ? (
            // The click handler only forwards the X's click (a real button, so keyboards reach it) bubbling up.
            <div className={f.brand} data-testid="desk-brand" onClick={brandClick}>
              {brand}
            </div>
          ) : null}
          <div className={f.top} ref={topRef}>
            {top}
          </div>
          <div className={f.content}>{children}</div>
        </div>
        {pane ? (
          <div className={f.pane} inert={covered}>
            {pane}
          </div>
        ) : null}
        {form ? (
          <div className={f.form} ref={formRef} data-desk-form="">
            {form}
          </div>
        ) : null}
      </div>
    </DeskContext.Provider>
  );
}
