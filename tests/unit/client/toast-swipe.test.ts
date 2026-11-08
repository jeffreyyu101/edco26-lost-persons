// Swipe a toast at the top away, iPhone-banner style (lib/client/toast-swipe.ts, Brian 2026-11-07): which way a
// drag goes, how far the toast follows, whether a release dismisses it or springs it back, and the click a swipe
// swallows. Also where the code is loaded from: never the first load (A25 had 1 B left). The pointer and touch
// wiring is end to end (tests/e2e/toast-swipe.spec.ts).
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISMISS_FRACTION, DRAG_SLOP_PX, FLICK_PX_PER_MS, SWALLOW_MS, clickToClose, shouldDismiss, swallowClick, toastIntent, toastOffset, toastOpacity } from '@/lib/client/toast-swipe';

describe('the thresholds', () => {
  it('a sheet’s slop and flick; 40 % of the toast’s height (up) or width (sideways)', () => {
    expect(DRAG_SLOP_PX).toBe(8);
    expect(FLICK_PX_PER_MS).toBe(0.6);
    expect(DISMISS_FRACTION).toBe(0.4);
  });
});

describe('toastIntent', () => {
  it('waits until the finger has moved the slop, any way (a tap stays a tap)', () => {
    expect(toastIntent(0, 0)).toBe('pending');
    expect(toastIntent(DRAG_SLOP_PX - 1, -(DRAG_SLOP_PX - 1))).toBe('pending');
    expect(toastIntent(-(DRAG_SLOP_PX - 1), 0)).toBe('pending');
    expect(toastIntent(0, DRAG_SLOP_PX - 1)).toBe('pending');
  });

  it('up (at least as much up as sideways) swipes it up', () => {
    expect(toastIntent(0, -DRAG_SLOP_PX)).toBe('y');
    expect(toastIntent(10, -10)).toBe('y');
    expect(toastIntent(-6, -30)).toBe('y');
  });

  it('sideways (more sideways than up or down) swipes it sideways, either way', () => {
    expect(toastIntent(DRAG_SLOP_PX, 0)).toBe('x');
    expect(toastIntent(-DRAG_SLOP_PX, 0)).toBe('x');
    expect(toastIntent(11, -10)).toBe('x');
    expect(toastIntent(-30, 20)).toBe('x');
  });

  it('down does nothing', () => {
    expect(toastIntent(0, DRAG_SLOP_PX)).toBe('none');
    expect(toastIntent(10, 10)).toBe('none');
    expect(toastIntent(-4, 40)).toBe('none');
  });
});

describe('toastOffset', () => {
  it('sideways follows the finger either way; up follows it up, never down past where it sits', () => {
    expect(toastOffset('x', -120, 30)).toBe(-120);
    expect(toastOffset('x', 80, -50)).toBe(80);
    expect(toastOffset('y', 15, -40)).toBe(-40);
    expect(toastOffset('y', 0, 25)).toBe(0);
  });
});

describe('shouldDismiss', () => {
  const H = 64;
  const W = 370;

  it('up: past 40 % of its height, held still before letting go', () => {
    expect(shouldDismiss(-H * DISMISS_FRACTION, H, 0)).toBe(true);
    expect(shouldDismiss(-50, H, 0)).toBe(true);
    expect(shouldDismiss(-(H * DISMISS_FRACTION - 1), H, 0)).toBe(false);
    expect(shouldDismiss(-14, H, -0.2)).toBe(false);
  });

  it('sideways: past 40 % of its width, left or right', () => {
    expect(shouldDismiss(W * DISMISS_FRACTION, W, 0)).toBe(true);
    expect(shouldDismiss(-W * DISMISS_FRACTION, W, 0)).toBe(true);
    expect(shouldDismiss(60, W, 0)).toBe(false);
    expect(shouldDismiss(-60, W, 0.1)).toBe(false);
  });

  it('a flick away dismisses it however short the drag', () => {
    expect(shouldDismiss(-10, H, -FLICK_PX_PER_MS)).toBe(true);
    expect(shouldDismiss(30, W, FLICK_PX_PER_MS)).toBe(true);
    expect(shouldDismiss(-30, W, -2)).toBe(true);
    expect(shouldDismiss(30, W, FLICK_PX_PER_MS - 0.01)).toBe(false);
  });

  it('springs back when flung back the other way, or not moved', () => {
    expect(shouldDismiss(-50, H, FLICK_PX_PER_MS)).toBe(false);
    expect(shouldDismiss(W * 0.8, W, -FLICK_PX_PER_MS)).toBe(false);
    expect(shouldDismiss(0, H, -3)).toBe(false);
    expect(shouldDismiss(0, W, 3)).toBe(false);
  });
});

describe('toastOpacity', () => {
  it('fades as it goes, to half at a full size away and no further', () => {
    expect(toastOpacity(0, 64)).toBe(1);
    expect(toastOpacity(-32, 64)).toBe(0.75);
    expect(toastOpacity(185, 370)).toBe(0.75);
    expect(toastOpacity(-400, 64)).toBe(0.5);
    expect(toastOpacity(10, 0)).toBe(1);
  });
});

describe('swallowClick', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const click = (target: EventTarget) => {
    const event = new Event('click', { cancelable: true });
    let stopped = false;
    const stop = event.stopPropagation.bind(event);
    event.stopPropagation = () => {
      stopped = true;
      stop();
    };
    target.dispatchEvent(event);
    return { prevented: event.defaultPrevented, stopped };
  };

  it('the click the release sends is cancelled and goes no further (a swipe from View never opens it)', () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    swallowClick(target);
    expect(click(target)).toEqual({ prevented: true, stopped: true });
  });

  it('a touch click comes in a later task: still swallowed a moment later, then only once', () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    swallowClick(target);
    vi.advanceTimersByTime(SWALLOW_MS - 100);
    expect(click(target)).toEqual({ prevented: true, stopped: true });
    // That was the swipe's click: the next one is a tap's.
    expect(click(target)).toEqual({ prevented: false, stopped: false });
  });

  it('until the next pointerdown (the next tap clicks as usual) or SWALLOW_MS, whichever comes first', () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    swallowClick(target);
    target.dispatchEvent(new Event('pointerdown'));
    expect(click(target)).toEqual({ prevented: false, stopped: false });

    const later = new EventTarget();
    const add = vi.spyOn(later, 'addEventListener');
    const remove = vi.spyOn(later, 'removeEventListener');
    swallowClick(later);
    expect(add).toHaveBeenCalledWith('click', expect.any(Function), { capture: true });
    expect(remove).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SWALLOW_MS);
    expect(remove).toHaveBeenCalledWith('click', add.mock.calls[0]![1], { capture: true });
    expect(click(later)).toEqual({ prevented: false, stopped: false });
  });

  it("the dismiss's own close (clickToClose) is never swallowed", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    swallowClick(target);
    let result: { prevented: boolean; stopped: boolean } | null = null;
    clickToClose({ click: () => (result = click(target)) });
    expect(result).toEqual({ prevented: false, stopped: false });
    // The browser's click for the swipe is still swallowed after it.
    expect(click(target)).toEqual({ prevented: true, stopped: true });
  });
});

describe('the first load (A25)', () => {
  const source = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

  it('the gesture code is loaded with import(), from the F4 host only, never by the Toaster', () => {
    expect(source('components/ui/use-toast-swipe.ts')).toContain("import('@/lib/client/toast-swipe')");
    expect(source('components/ui/use-toast-swipe.ts')).not.toMatch(/^import [^;]*toast-swipe'/m);
    expect(source('components/activity/ActivityHost.tsx')).toMatch(/^import \{ useToastSwipe \} from '@\/components\/ui\/use-toast-swipe';$/m);
    expect(source('components/ui/Toast.tsx')).not.toMatch(/^import [^;]*(toast-swipe|use-toast-swipe)'/m);
    expect(source('app/app-shell.tsx')).not.toMatch(/toast-swipe/);
  });
});
