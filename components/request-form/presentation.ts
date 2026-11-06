'use client';
// How the request form is presented (desktop-new-tablet.html frame 1, the responsive contract):
//   page   under 768 px: the phone's full-screen page, exactly as before
//   sheet  768–1023 (iPad portrait): one column in a 480 px side sheet over the right side, footer pinned
//   modal  1024 and up: a centred 760 px two-column modal over whatever page is open
// Looks live in request-form.css under [data-present]; this hook exists because behaviour changes too:
// sheet and modal are focus-trapping dialogs that close on Esc (or a click outside) and send on ⌘/Ctrl+↵.
// The form is a client-only chunk (next/dynamic, ssr: false), so the first render already has the real
// width: no flash. Server renders (unit tests) get 'page'.
import { createContext, useContext, useSyncExternalStore } from 'react';

export type FormPresentation = 'page' | 'sheet' | 'modal';

/** What a caller asks for: 'auto' picks by viewport width; the others force one presentation. */
export type FormPresentationChoice = 'auto' | FormPresentation;

/** The side sheet from this width (Radix Themes `sm`). */
export const FORM_SHEET_MIN_WIDTH = 768;
/** The centred modal from this width (Radix Themes `md`). */
export const FORM_MODAL_MIN_WIDTH = 1024;

const SHEET_QUERY = `(min-width: ${FORM_SHEET_MIN_WIDTH}px)`;
const MODAL_QUERY = `(min-width: ${FORM_MODAL_MIN_WIDTH}px)`;

/** The presentation for a viewport width in CSS px. */
export function presentationForWidth(width: number): FormPresentation {
  if (width >= FORM_MODAL_MIN_WIDTH) return 'modal';
  if (width >= FORM_SHEET_MIN_WIDTH) return 'sheet';
  return 'page';
}

/** True for the presentations drawn over another page (a dialog with a scrim). */
export function isOverlay(p: FormPresentation): boolean {
  return p !== 'page';
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const queries = [window.matchMedia(SHEET_QUERY), window.matchMedia(MODAL_QUERY)];
  for (const q of queries) q.addEventListener('change', onChange);
  return () => {
    for (const q of queries) q.removeEventListener('change', onChange);
  };
}

function snapshot(): FormPresentation {
  if (typeof window === 'undefined' || !window.matchMedia) return 'page';
  if (window.matchMedia(MODAL_QUERY).matches) return 'modal';
  if (window.matchMedia(SHEET_QUERY).matches) return 'sheet';
  return 'page';
}

const serverSnapshot = (): FormPresentation => 'page';

/** The presentation for the current viewport, live (rotating an iPad switches sheet ↔ modal). */
export function useViewportPresentation(): FormPresentation {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/** `choice` resolved against the viewport. */
export function useFormPresentation(choice: FormPresentationChoice = 'auto'): FormPresentation {
  const viewport = useViewportPresentation();
  return choice === 'auto' ? viewport : choice;
}

/** Set by RequestFormView for everything it renders (the form, its loading frame, the post picker). */
export const PresentationContext = createContext<FormPresentation>('page');

export function usePresentation(): FormPresentation {
  return useContext(PresentationContext);
}

// ---- ⌘↵ / Ctrl+↵ ------------------------------------------------------------------------------------

/** Apple keyboards say ⌘; everything else says Ctrl. */
export function isApplePlatform(nav: { platform?: string; userAgent?: string } | undefined): boolean {
  if (!nav) return false;
  return /Mac|iPhone|iPad|iPod/i.test(nav.platform ?? '') || /Mac OS X|iPhone|iPad/i.test(nav.userAgent ?? '');
}

/** The key cap on the Send button and the button's aria-keyshortcuts. */
export function sendShortcut(apple: boolean): { cap: string; aria: string } {
  return apple ? { cap: '⌘↵', aria: 'Meta+Enter' } : { cap: 'Ctrl ↵', aria: 'Control+Enter' };
}

/** ⌘↵ or Ctrl+↵ (never while an IME is composing; Shift / Alt variants are left alone). */
export function isSendShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; isComposing?: boolean }): boolean {
  return e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !e.isComposing;
}
