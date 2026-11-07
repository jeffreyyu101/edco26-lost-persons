// The on-screen keyboard on a phone (hotfix F5.1, Brian 2026-11-07). iOS Safari, and Android Chrome by default,
// keep the layout viewport when the keyboard opens: only the visual viewport shrinks, and it can pan
// (offsetTop). On iOS 26 its bottom can even lie below the layout viewport's, where Safari floats its tab bar,
// so anything fixed to the layout viewport's bottom floats mid-screen with the page showing under it.
//
//   followKeyboard(el)   while a keyboard is up, writes the visual viewport's box on `el` (data-kb,
//                        --lp-vv-top / --lp-vv-h, and --lp-vv-under: how much of it lies below the layout
//                        viewport's bottom), so a layer can sit flush on the keyboard. When a text field loses
//                        the focus to something that isn't one, the keyboard is going: the box goes at once,
//                        not after the keyboard's slide-out (when WebKit reports it).
//   lockPageScroll()     pins the page behind a sheet (body position: fixed at its scroll offset), so the
//                        keyboard's scroll-into-view can't move it; restores the offset when released.
//
// Used by every sheet (components/ui/Sheet.tsx) and the phone's request form (use-keyboard-fit.ts), which also
// keep the focused field in view inside their own scroller (revealDelta).

/** The visual viewport is this much shorter than the layout viewport when a keyboard is up. */
export const KEYBOARD_MIN_PX = 100;
/** At most this much of the visual viewport is taken to lie below the layout viewport (Safari's tab bar). */
export const UNDER_MAX_PX = 120;

export interface ViewportLike {
  height: number;
  offsetTop: number;
  scale: number;
}

export interface KeyboardBox {
  /** The visual viewport's top and height, in the layout viewport's coordinates (px). */
  top: number;
  height: number;
  /** How far its bottom lies below the layout viewport's (px; 0 when it doesn't). */
  under: number;
}

/**
 * The visual viewport's box while a keyboard covers part of the layout viewport (shorter by more than
 * KEYBOARD_MIN_PX at no zoom; a pinch zoom also shrinks it, so it never counts), else null.
 */
export function keyboardBox(layoutHeight: number, vv: ViewportLike): KeyboardBox | null {
  if (vv.scale > 1.01 || layoutHeight - vv.height <= KEYBOARD_MIN_PX) return null;
  const top = Math.round(vv.offsetTop);
  const height = Math.round(vv.height);
  return { top, height, under: Math.min(UNDER_MAX_PX, Math.max(0, top + height - Math.round(layoutHeight))) };
}

export interface VerticalBox {
  top: number;
  bottom: number;
}

/**
 * How far to scroll a scroller so `box` (the focused field or its row) sits inside `view` with `margin` to spare:
 * up when it is above, down when it is below but never past its top (a row taller than the view shows its top).
 * 0 when it is already in view.
 */
export function revealDelta(view: VerticalBox, box: VerticalBox, margin: number): number {
  const up = box.top - margin - view.top;
  if (up < 0) return up;
  const down = box.bottom + margin - view.bottom;
  return down > 0 ? Math.min(down, up) : 0;
}

const TEXT_FIELD =
  'input:not([type=button],[type=checkbox],[type=color],[type=file],[type=hidden],[type=image],[type=radio],[type=range],[type=reset],[type=submit]),textarea,[contenteditable=""],[contenteditable=true]';

/** True for an element that brings up the on-screen keyboard. */
export function isTextField(el: unknown): boolean {
  return !!el && typeof (el as Element).matches === 'function' && (el as Element).matches(TEXT_FIELD);
}

const VARS = ['--lp-vv-top', '--lp-vv-h', '--lp-vv-under'] as const;

/** Follows the visual viewport on `el` while a keyboard is up (see the top of this file). Returns the stop. */
export function followKeyboard(el: HTMLElement): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => undefined;
  // A text field lost the focus to something else: the keyboard is on its way down.
  let going = false;
  const show = (box: KeyboardBox | null) => {
    if (box) {
      [box.top, box.height, box.under].forEach((v, i) => el.style.setProperty(VARS[i]!, `${v}px`));
      el.dataset.kb = '';
    } else if (el.dataset.kb !== undefined) {
      delete el.dataset.kb;
      VARS.forEach((v) => el.style.removeProperty(v));
    }
  };
  const fit = () => show(going ? null : keyboardBox(window.innerHeight, vv));
  const focusIn = () => {
    if (!isTextField(document.activeElement)) return;
    going = false;
    fit();
  };
  const focusOut = (e: FocusEvent) => {
    if (isTextField(e.relatedTarget)) return;
    going = true;
    show(null);
  };
  fit();
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  document.addEventListener('focusin', focusIn, true);
  document.addEventListener('focusout', focusOut, true);
  return () => {
    vv.removeEventListener('resize', fit);
    vv.removeEventListener('scroll', fit);
    document.removeEventListener('focusin', focusIn, true);
    document.removeEventListener('focusout', focusOut, true);
    show(null);
  };
}

let locks = 0;
let lockedAt = 0;

/**
 * Pins the page where it is until every returned release has run (each one counts once). Important, because
 * Radix's own scroll lock sets body { position: relative !important }.
 */
export function lockPageScroll(): () => void {
  const body = document.body.style;
  const pin: ReadonlyArray<[string, string]> = [['position', 'fixed'], ['top', `${-window.scrollY}px`], ['left', '0'], ['right', '0']];
  if (locks++ === 0) {
    lockedAt = window.scrollY;
    for (const [k, v] of pin) body.setProperty(k, v, 'important');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--locks > 0) return;
    for (const [k] of pin) body.removeProperty(k);
    window.scrollTo(0, lockedAt);
  };
}
