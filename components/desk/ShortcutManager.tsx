'use client';
// The desk keyboard (from 768 px; rules in ./keyboard.ts): "/" search, N new request, J/K or ↓/↑ move
// through the main column's requests (opening each one when a request is open), Enter opens the selected
// request, Esc closes the sidebar opened over the content, else the open request (focus back on its row), and
// Cmd+B / Ctrl+B toggles the sidebar. A row clicked (or entered) while a
// request is open replaces it in the pane, so one close always closes. When a form (New request, edit)
// closes and leaves the focus on nothing, it goes back to where it was before the form opened (New
// request, the row, the pane's ⋯). Renders nothing.
import { useEffect, useRef } from 'react';
import { navigate, parseView, type View } from '@/lib/client/nav';
import { requestThreadJump } from '@/lib/client/thread-jump';
import { closePane, forgetHistoryEntries, noteHistoryEntry, openInPane, takeClosedPane } from './DetailPane';
import {
  FORM_LAYER_SELECTOR,
  MAIN_SELECTOR,
  OVERLAY_SELECTOR,
  PANE_SELECTOR,
  decideShortcut,
  describeTarget,
  inMessageLane,
  mainRowId,
  overlayOpen,
  readRowIds,
  rowElement,
  type ShortcutAction,
} from './keyboard';
import { neighbours } from './nav-model';
import { closeSidebarOverlay, sidebarOverlayOpen, toggleSidebar } from './sidebar-state';
import { isFormView, paneRequestId, type MainView } from './views';

export interface DeskKeysProps {
  view: View;
  main: MainView;
}

/** The row element (in the main column) that has focus, if any. */
function focusedRowId(): string | null {
  return mainRowId(document.activeElement);
}

/**
 * The request open in the pane and whether a form is open, read from the address bar. navigate() changes
 * it at once, while React re-renders a little later: a key pressed right after J, Enter or Esc has to see
 * where the previous key went, not the last render.
 */
function urlState(): { open: string | null; form: boolean } {
  const view = parseView(new URLSearchParams(window.location.search));
  return { open: paneRequestId(view), form: isFormView(view) };
}

function focusRow(el: HTMLElement): void {
  el.scrollIntoView({ block: 'nearest' });
  el.focus({ preventScroll: true });
}

/** Where the focus was outside any dialog, menu or form: the element, and its row's id if it is a row. */
interface FocusMark {
  el: HTMLElement;
  rowId: string | null;
}

/** Focus `fn()`'s element once the focus is on nothing, for up to ~30 frames while it renders. */
function refocusWhenFree(fn: () => HTMLElement | null): () => void {
  let frame = 0;
  let tries = 0;
  const attempt = () => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const el = fn();
    if (el) focusRow(el);
    else if (++tries < 30) frame = requestAnimationFrame(attempt);
  };
  frame = requestAnimationFrame(attempt);
  return () => cancelAnimationFrame(frame);
}

const shown = (el: HTMLElement | null | undefined): el is HTMLElement => !!el && el.isConnected && el.getClientRects().length > 0;

export function DeskKeys({ view, main }: DeskKeysProps) {
  const paneId = paneRequestId(view);
  const formOpen = isFormView(view);
  const latest = useRef(main);
  /** The selected row: the last one moved to, focused or opened. */
  const cursor = useRef<string | null>(paneId);
  /** The last focus outside dialogs, menus and the form layer (where a closed form gives it back). */
  const outside = useRef<FocusMark | null>(null);

  useEffect(() => {
    latest.current = main;
    if (paneId) cursor.current = paneId;
  });

  useEffect(() => {
    const run = (action: ShortcutAction, open: string | null) => {
      switch (action) {
        case 'search': {
          const input = document.querySelector<HTMLInputElement>('[data-desk-search]');
          if (input && input.getClientRects().length > 0) {
            input.focus();
            input.select();
          } else {
            navigate({ q: '' });
          }
          return;
        }
        case 'new':
          navigate({ new: true });
          return;
        case 'close':
          closePane(latest.current);
          return;
        case 'toggleSidebar':
          toggleSidebar();
          return;
        case 'closeSidebar':
          closeSidebarOverlay();
          return;
        case 'open':
          if (!cursor.current || cursor.current === open || !rowElement(cursor.current)) return;
          if (open) openInPane(cursor.current);
          else navigate({ r: cursor.current });
          return;
        case 'next':
        case 'prev': {
          const ids = readRowIds(document.querySelector(MAIN_SELECTOR));
          const onRow = focusedRowId();
          const from = open ?? onRow ?? cursor.current;
          const { prev, next } = neighbours(ids, from);
          const target = from !== null && ids.includes(from) ? (action === 'next' ? next : prev) : (ids[0] ?? null);
          if (!target) return;
          cursor.current = target;
          const el = rowElement(target);
          if (open) openInPane(target);
          // Focus follows, so Enter opens the row moved to and the row shows as selected. Only someone
          // working in the open request (a button in the pane) keeps their place there. Focus left on the
          // sidebar or the top bar (a click there, New request closed) follows too: kept there, the
          // next Enter would re-run that control instead of opening the row.
          const active = document.activeElement;
          if (el && !active?.closest(PANE_SELECTOR)) focusRow(el);
          return;
        }
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const { open, form } = urlState();
      const action = decideShortcut(e, describeTarget(e.target), {
        overlayOpen: overlayOpen(),
        formOpen: form,
        paneOpen: open !== null,
        sidebarOverlay: sidebarOverlayOpen(),
      });
      if (!action) return;
      e.preventDefault();
      run(action, open);
    };
    // A row clicked (or Enter on it) while a request is open opens in place, as J / K do: the rows push a
    // new entry each (the phone's screens), and the pane keeps one, so a single Esc or × closes it.
    // Capture on window, ahead of React's listeners, so the row's own click never runs. (Message lane) A click in
    // the row's message lane still lands at that request's Messages, as with nothing open (openRowAt): the jump
    // waits for its thread (the request open already, or the one about to open in place).
    const onClick = (e: MouseEvent) => {
      const { open, form } = urlState();
      if (!open || form) return;
      const id = mainRowId(e.target);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      cursor.current = id;
      if (inMessageLane(e.target)) requestThreadJump(id);
      if (id !== open) openInPane(id);
    };
    const onFocusIn = (e: FocusEvent) => {
      const id = focusedRowId();
      if (id) cursor.current = id;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el && el !== document.body && !el.closest(OVERLAY_SELECTOR) && !el.closest(FORM_LAYER_SELECTOR)) outside.current = { el, rowId: id };
    };
    // Focus let go to nothing on purpose (Esc in the search field, a click on empty space) leaves nothing
    // to return to. Not when a form covering the desk made it inert, or the window lost focus, and not when
    // it leaves a dialog, menu or the form layer: closing one removes its focused field, which Chromium
    // reports as a focusout to nothing, and that close is exactly when the focus should go back.
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget || !document.hasFocus()) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (!el || !el.isConnected || el.closest('[inert]') || el.closest(OVERLAY_SELECTOR) || el.closest(FORM_LAYER_SELECTOR)) return;
      outside.current = null;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('click', onClick, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('click', onClick, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      forgetHistoryEntries();
    };
  }, []);

  // What each history entry shows, so a close can step back past requests opened over requests.
  useEffect(() => {
    noteHistoryEntry();
  }, [view]);

  // When the pane closes (Esc, ×, Back) with the focus left on nothing, the focus returns to its row.
  const lastPane = useRef(paneId);
  useEffect(() => {
    const rendered = lastPane.current;
    lastPane.current = paneId;
    if (!rendered || paneId || formOpen) return;
    // The request the address bar had open (a quick K then Esc can close before its render lands).
    const was = takeClosedPane() ?? rendered;
    return refocusWhenFree(() => rowElement(was));
  }, [paneId, formOpen]);

  // When a form closes (Esc, ×, Cancel, Send, Back) with the focus left on nothing (a dialog with no
  // trigger gives it to the page), it returns to where it was: New request, the row, the pane's ⋯.
  const lastForm = useRef(formOpen);
  useEffect(() => {
    const was = lastForm.current;
    lastForm.current = formOpen;
    if (!was || formOpen) return;
    const mark = outside.current;
    if (!mark) return;
    return refocusWhenFree(() => (shown(mark.el) ? mark.el : mark.rowId ? rowElement(mark.rowId) : null));
  }, [formOpen]);

  return null;
}
