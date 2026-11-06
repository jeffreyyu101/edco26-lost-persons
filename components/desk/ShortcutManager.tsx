'use client';
// The desk keyboard (from 768 px; rules in ./keyboard.ts): "/" search, N new request, J/K or ↓/↑ move
// through the main column's requests (opening each one when a request is open), Enter opens the selected
// request, Esc closes the open one and puts focus back on its row. Renders nothing.
import { useEffect, useRef } from 'react';
import { navigate, type View } from '@/lib/client/nav';
import { closePane, openInPane } from './DetailPane';
import { MAIN_SELECTOR, ROW_SELECTOR, decideShortcut, describeTarget, overlayOpen, readRowIds, rowElement, type ShortcutAction } from './keyboard';
import { neighbours } from './nav-model';
import { isFormView, paneRequestId, type MainView } from './views';

export interface DeskKeysProps {
  view: View;
  main: MainView;
}

/** The row element (in the main column) that has focus, if any. */
function focusedRowId(): string | null {
  const active = document.activeElement as HTMLElement | null;
  return active?.closest?.(`${MAIN_SELECTOR} ${ROW_SELECTOR}`)?.getAttribute('data-request-id') ?? null;
}

function focusRow(el: HTMLElement): void {
  el.scrollIntoView({ block: 'nearest' });
  el.focus({ preventScroll: true });
}

export function DeskKeys({ view, main }: DeskKeysProps) {
  const paneId = paneRequestId(view);
  const formOpen = isFormView(view);
  const latest = useRef({ paneId, formOpen, main });
  /** The selected row: the last one moved to, focused or opened. */
  const cursor = useRef<string | null>(paneId);

  useEffect(() => {
    latest.current = { paneId, formOpen, main };
    if (paneId) cursor.current = paneId;
  });

  useEffect(() => {
    const run = (action: ShortcutAction) => {
      const { paneId: open, main: current } = latest.current;
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
          closePane(current);
          return;
        case 'open':
          if (cursor.current && rowElement(cursor.current)) navigate({ r: cursor.current });
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
          // Focus follows unless it is somewhere else on purpose (a button in the pane, the sidebar).
          const active = document.activeElement;
          if (el && (onRow !== null || !active || active === document.body)) focusRow(el);
          return;
        }
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const { paneId: open, formOpen: form } = latest.current;
      const action = decideShortcut(e, describeTarget(e.target), { overlayOpen: overlayOpen(), formOpen: form, paneOpen: open !== null });
      if (!action) return;
      e.preventDefault();
      run(action);
    };
    const onFocusIn = () => {
      const id = focusedRowId();
      if (id) cursor.current = id;
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  // When the pane closes (Esc, ×, Back) with the focus left on nothing, the focus returns to its row.
  const lastPane = useRef(paneId);
  useEffect(() => {
    const was = lastPane.current;
    lastPane.current = paneId;
    if (!was || paneId || formOpen) return;
    let frame = 0;
    let tries = 0;
    const tryFocus = () => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const el = rowElement(was);
      if (el) focusRow(el);
      else if (++tries < 30) frame = requestAnimationFrame(tryFocus);
    };
    frame = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(frame);
  }, [paneId, formOpen]);

  return null;
}
