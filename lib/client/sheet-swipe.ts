// Swipe a phone bottom sheet down to close it (hotfix, Brian 2026-11-07 from the iPhone Home Screen app: "it
// doesn't easily scroll away, I can't drag and close it easily"). Every sheet (components/ui/Sheet.tsx) and the
// Activity sheet (components/activity/ActivityBell.tsx) attach it while open (components/ui/use-sheet-swipe.ts,
// which loads this file on demand, outside the first load).
//
//   start    a pointer (finger, pen, mouse) goes down in the sheet, but not in a text field, a slider or a
//            sideways scroller, and not on something that took the pointer itself (preventDefault on
//            pointerdown, the crop frame)
//   claim    once it has moved DRAG_SLOP_PX: down (more down than sideways), from the grabber / header
//            ([data-sheet-grab]) or with every scroller under it at its top → the sheet follows the finger and
//            a focused field lets go (the keyboard goes); anything else (up, sideways, a list scrolled down) is
//            left to the browser, so it scrolls
//   release  past CLOSE_FRACTION of the sheet's height, or a flick down faster than FLICK_PX_PER_MS → `dismiss`
//            (the Escape / scrim path: Radix onOpenChange(false)), and the sheet slides on from where the finger
//            left it (data-lp-swiped; none with reduced motion); else it springs back (at once with reduced
//            motion). A sheet its owner keeps open (Add photo while it uploads) springs back too.
//
// Touch: while the gesture could still be a swipe, its touchmoves are cancelled, so iOS and Android never start
// a scroll or an overscroll bounce under it (which would take the pointer away, pointercancel).
import { isTextField } from './visual-viewport';

/** Movement (px) before the gesture is a swipe of the sheet or left to the browser. */
export const DRAG_SLOP_PX = 8;
/** A release past this share of the sheet's height closes it. */
export const CLOSE_FRACTION = 0.25;
/** A release moving down at least this fast (px/ms) closes it wherever it is; as fast up keeps it open. */
export const FLICK_PX_PER_MS = 0.6;
/** The release velocity is measured over the pointer's last this-many ms. */
export const VELOCITY_WINDOW_MS = 100;
const SETTLE_MS = 220;

export interface SwipeSample {
  /** clientY (px). */
  y: number;
  /** Event time (ms). */
  t: number;
}

/**
 * What a pointer that moved (dx, dy) from where it went down is doing: still undecided, pulling the sheet down
 * (only when `canPull`: from the grabber, or nothing under it can scroll up), or something for the browser.
 */
export function swipeIntent(dx: number, dy: number, canPull: boolean): 'pending' | 'drag' | 'release' {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_SLOP_PX) return 'pending';
  return canPull && dy >= Math.abs(dx) ? 'drag' : 'release';
}

/** px/ms over the last VELOCITY_WINDOW_MS of `samples` (time order; down is positive), 0 without a span. */
export function releaseVelocity(samples: readonly SwipeSample[]): number {
  const last = samples.at(-1);
  if (!last) return 0;
  const first = samples.find((s) => s.t >= last.t - VELOCITY_WINDOW_MS) ?? last;
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
}

/** Whether a sheet `height` px tall, let go `offset` px down at `velocity` px/ms, closes. */
export function shouldClose(offset: number, height: number, velocity: number): boolean {
  if (offset <= 0 || velocity <= -FLICK_PX_PER_MS) return false;
  return velocity >= FLICK_PX_PER_MS || offset >= height * CLOSE_FRACTION;
}

/** The elements from `from` up to `sheet` (inclusive) that scroll along `axis`. */
function scrollers(from: Element, sheet: HTMLElement, axis: 'x' | 'y'): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let el: Element | null = from; el; el = el === sheet ? null : el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    const overflow = getComputedStyle(el)[axis === 'y' ? 'overflowY' : 'overflowX'];
    const more = axis === 'y' ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
    if (more && (overflow === 'auto' || overflow === 'scroll')) out.push(el);
  }
  return out;
}

interface Gesture {
  id: number;
  x: number;
  y: number;
  grab: boolean;
  scrollers: HTMLElement[];
  /** clientY where the sheet started to follow; null until then. */
  from: number | null;
  offset: number;
  samples: SwipeSample[];
}

/**
 * Lets `sheet` (a Radix Dialog content, data-state open / closed) be swiped down; `dismiss` closes it and must
 * render synchronously (flushSync), so a sheet that stayed open can spring back. Returns the detach.
 */
export function attachSheetSwipe(sheet: HTMLElement, dismiss: () => void): () => void {
  let g: Gesture | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const style = sheet.style;
  const canPull = (x: Gesture) => x.grab || x.scrollers.every((el) => el.scrollTop <= 0);

  const settle = () => {
    const animate = style.transform !== '' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    style.transition = animate ? `transform ${SETTLE_MS}ms cubic-bezier(0.16, 1, 0.3, 1)` : '';
    style.transform = '';
    clearTimeout(timer);
    if (!animate) return;
    timer = setTimeout(() => {
      if (!g || g.from === null) style.transition = '';
    }, SETTLE_MS + 40);
  };

  const down = (e: PointerEvent) => {
    if (g) {
      // A second finger: put the sheet back.
      if (e.pointerId === g.id) return;
      if (g.from !== null) settle();
      g = null;
      return;
    }
    const t = e.target;
    if (!(t instanceof Element) || !sheet.contains(t) || sheet.dataset.state !== 'open') return;
    if (e.defaultPrevented || !e.isPrimary || e.button > 0) return;
    if (isTextField(t.closest('input, textarea, [contenteditable]')) || t.closest('input[type=range], select, [role=slider], [data-sheet-nodrag]')) return;
    if (scrollers(t, sheet, 'x').length > 0) return;
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, grab: !!t.closest('[data-sheet-grab]'), scrollers: scrollers(t, sheet, 'y'), from: null, offset: 0, samples: [] };
  };

  const move = (e: PointerEvent) => {
    if (!g || e.pointerId !== g.id) return;
    if (g.from === null) {
      const intent = swipeIntent(e.clientX - g.x, e.clientY - g.y, canPull(g));
      if (intent === 'pending') return;
      if (intent === 'release') {
        g = null;
        return;
      }
      g.from = e.clientY;
      clearTimeout(timer);
      style.transition = 'none';
      // Its slide-in never replays (ui.module.css, activity.module.css).
      sheet.setAttribute('data-lp-dragged', '');
      // A focused field lets go first: the keyboard goes down and the sheet with it (followKeyboard).
      const field = document.activeElement;
      if (field instanceof HTMLElement && sheet.contains(field) && isTextField(field)) field.blur();
      getSelection()?.removeAllRanges();
    }
    g.offset = Math.max(0, e.clientY - g.from);
    g.samples.push({ y: e.clientY, t: e.timeStamp });
    if (g.samples.length > 32) g.samples.shift();
    style.transform = g.offset > 0 ? `translateY(${g.offset}px)` : '';
  };

  const up = (e: PointerEvent) => {
    if (!g || e.pointerId !== g.id) return;
    const { from, offset, samples } = g;
    g = null;
    if (from === null) return;
    // The click a mouse would send now (down and up on one control) is part of the drag.
    const swallow = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    samples.push({ y: e.clientY, t: e.timeStamp });
    if (e.type === 'pointerup' && shouldClose(offset, sheet.offsetHeight, releaseVelocity(samples))) {
      style.setProperty('--lp-swipe-y', `${offset}px`);
      sheet.setAttribute('data-lp-swiped', '');
      dismiss();
      // Closed (sliding out, or gone at once: reduced motion, or an owner that unmounts it).
      if (!sheet.isConnected || sheet.dataset.state !== 'open') return;
      // Kept open by its owner.
      sheet.removeAttribute('data-lp-swiped');
    }
    settle();
  };

  const touchMove = (e: TouchEvent) => {
    if (!g || !e.cancelable) return;
    const touch = e.touches.length === 1 ? e.touches[0] : undefined;
    if (g.from !== null || (touch && touch.clientY > g.y && canPull(g))) e.preventDefault();
  };

  window.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  sheet.addEventListener('touchmove', touchMove, { passive: false });
  return () => {
    window.removeEventListener('pointerdown', down);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    sheet.removeEventListener('touchmove', touchMove);
    clearTimeout(timer);
    g = null;
  };
}
