'use client';
// Tablet and desktop (>= 768 px) keyboard touches for sign-in (design/screens/desktop-sign-in.html): the
// first field is focused on load, Enter continues or signs in, 1–4 pick a team, Esc on step 2 goes back.
// Looks (the key caps, the card) are CSS media queries in signin.module.css; only behaviour lives here.
// Under 768 px the phone sign-in is unchanged: no autofocus, no shortcuts.
import { useEffect, useRef, useSyncExternalStore } from 'react';

/** Radix Themes `sm`: the tablet and desktop layouts start here. Keep in step with signin.module.css. */
export const WIDE_QUERY = '(min-width: 768px)';

export function isWide(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY).matches;
}

function subscribeWide(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
const notWideOnServer = () => false;

/** True at >= 768 px, live (a window resized across the breakpoint turns the shortcuts on or off). */
export function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, isWide, notWideOnServer);
}

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

/** Somewhere keys are typed text (an input, textarea, select or editable element), never shortcuts. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  return false;
}

/** A control that Enter already activates (a button or link), other than a radio card. */
export function isEnterControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest('button, a[href], [role="button"], [role="link"], [role="menuitem"], summary');
  return control !== null && control.getAttribute('role') !== 'radio';
}

/**
 * Calls `onKey` for document keydowns while `enabled`. Never sees a key pressed with Cmd, Ctrl or Alt (the
 * browser's shortcuts, e.g. Cmd+1 for a tab) or during IME composition. The latest `onKey` is always used.
 */
export function useStepKeys(enabled: boolean, onKey: (event: KeyboardEvent) => void): void {
  const latest = useRef(onKey);
  useEffect(() => {
    latest.current = onKey;
  });
  useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      latest.current(event);
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [enabled]);
}
