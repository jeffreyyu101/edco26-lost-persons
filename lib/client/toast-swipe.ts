// Swipe a toast at the top away, iPhone-banner style (Brian 2026-11-07 from the iPhone Home Screen app: "i should
// also be able to swipe it away like what people would expect with iphones and notifications"). Attached to the
// Toaster (components/ui/Toast.tsx, .lp-toaster) while a toast shows, by components/ui/use-toast-swipe.ts, which
// loads this file on demand from the shell's F4 host: the first load (A25) carries none of it, and the build is
// precached, so it loads offline too. Until it is there, a tap and ✕ still close a toast.
//
//   start    a finger or pen goes down on a toast (.lp-toast). A mouse never swipes: it clicks to close, and ✕.
//   claim    once it has moved DRAG_SLOP_PX: up (at least as much up as sideways) or sideways → the toast follows
//            the finger along that axis and fades; down → nothing (the toast stays put, the page does not scroll)
//   release  past DISMISS_FRACTION of the toast's height (up) or width (sideways), or a flick that way faster than
//            FLICK_PX_PER_MS → it slides on out and closes; else it springs back. Reduced motion: it closes, or is
//            back, at once. It closes through its own tap-to-close (the toast's click, the same dismiss as a tap),
//            so the Toaster carries nothing per toast.
//   taps     under the slop nothing moves: a tap closes the toast or runs its button (View, Reload) as before.
//            After a swipe, the click the release could still send is swallowed: a swipe from View never opens.
//
// Touch: a toast has touch-action: none (ui.module.css) and every touchmove on it is cancelled, so the page never
// scrolls or bounces under the gesture; anywhere else on the page it scrolls as usual.
import { DRAG_SLOP_PX, FLICK_PX_PER_MS, releaseVelocity, type SwipeSample } from './sheet-swipe';

export { DRAG_SLOP_PX, FLICK_PX_PER_MS };
/** A release past this share of the toast's height (up) or width (sideways) dismisses it. */
export const DISMISS_FRACTION = 0.4;
/** How much the toast fades as it follows the finger (at its full height or width away). */
const DRAG_FADE = 0.5;
const OUT_MS = 200;
const SETTLE_MS = 220;

export type ToastAxis = 'x' | 'y';

/**
 * What a pointer that moved (dx, dy) from where it went down on a toast is doing: still undecided, swiping it
 * sideways ('x') or up ('y'), or nothing ('none': a drag down, which leaves the toast where it is).
 */
export function toastIntent(dx: number, dy: number): 'pending' | ToastAxis | 'none' {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < DRAG_SLOP_PX) return 'pending';
  if (ax > ay) return 'x';
  return dy < 0 ? 'y' : 'none';
}

/** The toast's offset (px) along `axis` for a finger (dx, dy) from where the swipe began: sideways either way, up only. */
export function toastOffset(axis: ToastAxis, dx: number, dy: number): number {
  return axis === 'x' ? dx : Math.min(0, dy);
}

/**
 * Whether a toast `size` px long on the swipe's axis, let go `offset` px from where it sits (up and left are
 * negative) moving at `velocity` px/ms (signed the same way), is dismissed: past DISMISS_FRACTION of its size or
 * flicked away, and never when flung back.
 */
export function shouldDismiss(offset: number, size: number, velocity: number): boolean {
  if (offset === 0) return false;
  const away = Math.sign(offset) * velocity;
  if (away <= -FLICK_PX_PER_MS) return false;
  return away >= FLICK_PX_PER_MS || Math.abs(offset) >= size * DISMISS_FRACTION;
}

/** The toast's opacity `offset` px from where it sits, `size` px long on that axis. */
export function toastOpacity(offset: number, size: number): number {
  return size > 0 ? 1 - DRAG_FADE * Math.min(1, Math.abs(offset) / size) : 1;
}

/**
 * Swallows the click the browser may still send for the pointer just let go (a swipe is not a tap: one that began
 * on View or ✕ runs neither). Captured on `target` (the window), until the end of this task.
 */
export function swallowClick(target: EventTarget = window): void {
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  // ({capture} rather than `true`: Node's EventTarget, under the unit tests, removes only that form.)
  target.addEventListener('click', swallow, { capture: true });
  setTimeout(() => target.removeEventListener('click', swallow, { capture: true }), 0);
}

interface Gesture {
  id: number;
  toast: HTMLElement;
  x: number;
  y: number;
  /** null until the toast follows the finger. */
  axis: ToastAxis | null;
  /** Where the finger was when it began to follow (client px). */
  fromX: number;
  fromY: number;
  offset: number;
  /** Positions along the axis (SwipeSample.y) and their times, for the release velocity. */
  samples: SwipeSample[];
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const sizeOn = (toast: HTMLElement, axis: ToastAxis) => (axis === 'x' ? toast.offsetWidth : toast.offsetHeight);
const translate = (axis: ToastAxis, px: number) => `translate${axis === 'x' ? 'X' : 'Y'}(${px}px)`;

/** Lets every toast in `toaster` (the Toaster's live region), now and later, be swiped away. Returns the detach. */
export function attachToastSwipe(toaster: HTMLElement): () => void {
  let g: Gesture | null = null;
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  /** Toasts sliding out: no new swipe on them. */
  const leaving = new WeakSet<HTMLElement>();
  const cancel = (toast: HTMLElement) => {
    clearTimeout(timers.get(toast));
    timers.delete(toast);
  };
  const later = (toast: HTMLElement, run: () => void, ms: number) => {
    cancel(toast);
    timers.set(
      toast,
      setTimeout(() => {
        timers.delete(toast);
        run();
      }, ms),
    );
  };

  /** Back where it sits (at once with reduced motion, or when it never moved). */
  const settle = (toast: HTMLElement) => {
    const style = toast.style;
    const animate = style.transform !== '' && !reducedMotion();
    style.transition = animate ? `transform ${SETTLE_MS}ms cubic-bezier(0.16, 1, 0.3, 1), opacity ${SETTLE_MS}ms ease-out` : '';
    style.transform = '';
    style.opacity = '';
    cancel(toast);
    if (animate)
      later(
        toast,
        () => {
          if (g?.toast !== toast) style.transition = '';
        },
        SETTLE_MS + 40,
      );
  };

  /** Slides it on out the way it went (not with reduced motion), then closes it with its own tap-to-close. */
  const dismiss = (toast: HTMLElement, axis: ToastAxis, offset: number) => {
    leaving.add(toast);
    const close = () => toast.click();
    if (reducedMotion()) return close();
    // Sideways: a screen's width on; up: until its bottom edge is past the top of the screen.
    const to = axis === 'x' ? offset + Math.sign(offset) * innerWidth : offset - toast.getBoundingClientRect().bottom - 8;
    const style = toast.style;
    style.transition = `transform ${OUT_MS}ms ease-out, opacity ${OUT_MS}ms ease-out`;
    style.transform = translate(axis, to);
    style.opacity = '0';
    later(toast, close, OUT_MS);
  };

  const stop = () => {
    g = null;
    window.removeEventListener('pointerdown', other, true);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };

  const down = (e: PointerEvent) => {
    if (g || e.defaultPrevented || !e.isPrimary || e.button > 0 || e.pointerType === 'mouse') return;
    const toast = e.target instanceof Element ? e.target.closest<HTMLElement>('.lp-toast') : null;
    if (!toast || !toaster.contains(toast) || leaving.has(toast)) return;
    g = { id: e.pointerId, toast, x: e.clientX, y: e.clientY, axis: null, fromX: 0, fromY: 0, offset: 0, samples: [] };
    window.addEventListener('pointerdown', other, true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  /** A second finger: the toast goes back. */
  const other = (e: PointerEvent) => {
    if (!g || e.pointerId === g.id) return;
    const { toast, axis } = g;
    stop();
    if (axis) settle(toast);
  };

  const move = (e: PointerEvent) => {
    if (!g || e.pointerId !== g.id) return;
    const { toast } = g;
    const style = toast.style;
    if (!g.axis) {
      const intent = toastIntent(e.clientX - g.x, e.clientY - g.y);
      if (intent === 'pending') return;
      // A drag down: nothing (a tap that moved; the browser sends no click).
      if (intent === 'none') return stop();
      g.axis = intent;
      g.fromX = e.clientX;
      g.fromY = e.clientY;
      cancel(toast);
      style.transition = 'none';
      // Its slide-in never replays (ui.module.css .toast), and never holds it in place mid-drag.
      style.animation = 'none';
      getSelection()?.removeAllRanges();
    }
    g.offset = toastOffset(g.axis, e.clientX - g.fromX, e.clientY - g.fromY);
    g.samples.push({ y: g.offset, t: e.timeStamp });
    if (g.samples.length > 32) g.samples.shift();
    style.transform = g.offset ? translate(g.axis, g.offset) : '';
    style.opacity = g.offset ? String(toastOpacity(g.offset, sizeOn(toast, g.axis))) : '';
  };

  const up = (e: PointerEvent) => {
    if (!g || e.pointerId !== g.id) return;
    const { toast, axis, fromX, fromY, samples } = g;
    let { offset } = g;
    stop();
    // A tap: the browser's click closes the toast or runs its button, as before.
    if (!axis) return;
    if (e.type === 'pointerup') {
      offset = toastOffset(axis, e.clientX - fromX, e.clientY - fromY);
      samples.push({ y: offset, t: e.timeStamp });
    }
    if (e.type === 'pointerup' && shouldDismiss(offset, sizeOn(toast, axis), releaseVelocity(samples))) dismiss(toast, axis, offset);
    else settle(toast);
    // (After a dismiss: with reduced motion, its own close is a click too.)
    swallowClick();
  };

  const touchMove = (e: TouchEvent) => {
    // Only a toast takes touches in the toaster (pointer-events: none around them).
    if (e.cancelable) e.preventDefault();
  };

  toaster.addEventListener('pointerdown', down);
  toaster.addEventListener('touchmove', touchMove, { passive: false });
  return () => {
    toaster.removeEventListener('pointerdown', down);
    toaster.removeEventListener('touchmove', touchMove);
    if (g) {
      const { toast, axis } = g;
      stop();
      if (axis) settle(toast);
    }
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
