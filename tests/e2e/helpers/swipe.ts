// Swipes for the bottom sheets (lib/client/sheet-swipe.ts), the same in Chromium and WebKit.
//
//   swipe(locator, dy)       touch pointer events from the element's centre (pointerdown, pointermove every
//                            ms / steps, pointerup), each followed by the touch event the browser would send,
//                            in real time (the release velocity is measured). Returns, per move, whether the page
//                            cancelled that touchmove (it does while the swipe could be the sheet's, so the
//                            browser never scrolls under it), and how far the sheet (the dialog around the
//                            element) was moved just before the finger let go. Synthetic: nothing scrolls.
//   realTouchSwipe(page, …)  Chromium only: a real touch through DevTools (Input.dispatchTouchEvent), which the
//                            browser also scrolls with when the page lets it.
import type { Locator, Page } from '@playwright/test';

export interface SwipeOptions {
  /** How long the moves take (ms). */
  ms?: number;
  steps?: number;
  /** Held still this long before letting go (ms): no flick, the distance alone decides. */
  hold?: number;
}

export interface SwipeResult {
  cancelled: boolean[];
  /** The dialog's translateY (px) just before the release (0 when it never moved). */
  moved: number;
}

export async function swipe(el: Locator, dy: number, { ms = 320, steps = 12, hold = 0 }: SwipeOptions = {}): Promise<SwipeResult> {
  return el.evaluate(
    async (node, o) => {
      const box = node.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y0 = box.top + box.height / 2;
      const id = 41;
      const pointer = (type: string, clientY: number) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: id,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY,
          button: type === 'pointermove' ? -1 : 0,
          buttons: type === 'pointerup' ? 0 : 1,
        });
      // (Radix's scroll lock reads changedTouches, from the touchstart on.)
      const touch = (type: string, clientY: number) => {
        const ev = new Event(type, { bubbles: true, cancelable: true, composed: true });
        const point = [{ clientX: x, clientY, identifier: id, target: node }];
        const down = type === 'touchend' ? [] : point;
        Object.defineProperties(ev, { touches: { value: down }, targetTouches: { value: down }, changedTouches: { value: point } });
        return ev;
      };
      const sleep = (t: number) => new Promise((r) => setTimeout(r, t));
      node.dispatchEvent(pointer('pointerdown', y0));
      node.dispatchEvent(touch('touchstart', y0));
      const cancelled: boolean[] = [];
      for (let i = 1; i <= o.steps; i += 1) {
        await sleep(o.ms / o.steps);
        const y = y0 + (o.dy * i) / o.steps;
        node.dispatchEvent(pointer('pointermove', y));
        cancelled.push(!node.dispatchEvent(touch('touchmove', y)));
      }
      if (o.hold > 0) await sleep(o.hold);
      const dialog = node.closest('[role="dialog"]');
      const moved = dialog ? new DOMMatrixReadOnly(getComputedStyle(dialog).transform).m42 : 0;
      node.dispatchEvent(pointer('pointerup', y0 + o.dy));
      node.dispatchEvent(touch('touchend', y0 + o.dy));
      return { cancelled, moved };
    },
    { dy, ms, steps, hold },
  );
}

/** A real touch drag from (x, y) down by dy (Chromium only). */
export async function realTouchSwipe(page: Page, x: number, y: number, dy: number, { ms = 320, steps = 12, hold = 0 }: SwipeOptions = {}): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= steps; i += 1) {
      await page.waitForTimeout(ms / steps);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * i) / steps }] });
    }
    if (hold > 0) await page.waitForTimeout(hold);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}
