// Swipe a phone bottom sheet down to close it (lib/client/sheet-swipe.ts, hotfix 2026-11-07): when a drag is
// the sheet's and when it is the browser's (a scroll), the release velocity, and whether a release closes.
// The pointer and touch wiring is end to end (tests/e2e/sheet-swipe.spec.ts).
import { describe, expect, it } from 'vitest';
import { CLOSE_FRACTION, DRAG_SLOP_PX, FLICK_PX_PER_MS, VELOCITY_WINDOW_MS, releaseVelocity, shouldClose, swipeIntent } from '@/lib/client/sheet-swipe';

describe('the thresholds', () => {
  it('are the agreed ones: a quarter of the height, a 0.6 px/ms flick, measured over the last 100 ms', () => {
    expect(CLOSE_FRACTION).toBe(0.25);
    expect(FLICK_PX_PER_MS).toBe(0.6);
    expect(VELOCITY_WINDOW_MS).toBe(100);
    expect(DRAG_SLOP_PX).toBeGreaterThanOrEqual(4);
    expect(DRAG_SLOP_PX).toBeLessThanOrEqual(12);
  });
});

describe('swipeIntent', () => {
  it('waits until the pointer has moved the slop, either way', () => {
    expect(swipeIntent(0, 0, true)).toBe('pending');
    expect(swipeIntent(DRAG_SLOP_PX - 1, DRAG_SLOP_PX - 1, true)).toBe('pending');
    expect(swipeIntent(0, -(DRAG_SLOP_PX - 1), true)).toBe('pending');
  });

  it('pulls the sheet down when the move is down (at least as much down as sideways) and it can be pulled', () => {
    expect(swipeIntent(0, DRAG_SLOP_PX, true)).toBe('drag');
    expect(swipeIntent(10, 10, true)).toBe('drag');
    expect(swipeIntent(-10, 30, true)).toBe('drag');
  });

  it('leaves everything else to the browser: up (a scroll), sideways, or a list scrolled down', () => {
    expect(swipeIntent(0, -DRAG_SLOP_PX, true)).toBe('release');
    expect(swipeIntent(11, 10, true)).toBe('release');
    expect(swipeIntent(-20, 4, true)).toBe('release');
    // Something under the finger can still scroll up: the drag down scrolls it.
    expect(swipeIntent(0, 40, false)).toBe('release');
  });
});

describe('releaseVelocity', () => {
  it('is 0 without a time span', () => {
    expect(releaseVelocity([])).toBe(0);
    expect(releaseVelocity([{ y: 10, t: 5 }])).toBe(0);
    expect(releaseVelocity([{ y: 10, t: 5 }, { y: 30, t: 5 }])).toBe(0);
  });

  it('is px/ms over the last 100 ms, down positive', () => {
    const flick = [0, 16, 32, 48, 64].map((t, i) => ({ y: 100 + i * 16, t }));
    expect(releaseVelocity(flick)).toBeCloseTo(1, 5);
    const up = [0, 20, 40].map((t, i) => ({ y: 300 - i * 30, t }));
    expect(releaseVelocity(up)).toBeCloseTo(-1.5, 5);
  });

  it('forgets the start of a slow drag: only the last 100 ms count', () => {
    // 200 px in the first 400 ms, then a 30 ms flick of 45 px.
    const samples = [
      { y: 0, t: 0 },
      { y: 100, t: 200 },
      { y: 200, t: 400 },
      { y: 215, t: 410 },
      { y: 230, t: 420 },
      { y: 245, t: 430 },
    ];
    expect(releaseVelocity(samples)).toBeCloseTo(1.5, 5);
  });

  it('is 0 when the finger stopped before it let go', () => {
    // Dragged fast, then held still for 150 ms: the release (the last sample) is all the window holds.
    const samples = [
      { y: 0, t: 0 },
      { y: 120, t: 60 },
      { y: 120, t: 210 },
    ];
    expect(releaseVelocity(samples)).toBe(0);
  });
});

describe('shouldClose', () => {
  const H = 400;

  it('closes past a quarter of the height, without a flick', () => {
    expect(shouldClose(H * CLOSE_FRACTION, H, 0)).toBe(true);
    expect(shouldClose(H * 0.6, H, 0.1)).toBe(true);
    expect(shouldClose(H * CLOSE_FRACTION - 1, H, 0)).toBe(false);
    expect(shouldClose(40, H, 0.2)).toBe(false);
  });

  it('closes on a flick down, however short the drag', () => {
    expect(shouldClose(12, H, FLICK_PX_PER_MS)).toBe(true);
    expect(shouldClose(12, H, 2)).toBe(true);
    expect(shouldClose(12, H, FLICK_PX_PER_MS - 0.01)).toBe(false);
  });

  it('stays open when flung back up, or not moved at all', () => {
    expect(shouldClose(H * 0.8, H, -FLICK_PX_PER_MS)).toBe(false);
    expect(shouldClose(0, H, 3)).toBe(false);
  });

  it('measures against the sheet: the same drag closes a short sheet, not a tall one', () => {
    expect(shouldClose(120, 300, 0)).toBe(true);
    expect(shouldClose(120, 760, 0)).toBe(false);
  });
});
