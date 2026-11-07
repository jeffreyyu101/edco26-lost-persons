'use client';
// The request form with the on-screen keyboard up. Every group is open, so the form scrolls. Phones keep
// the layout viewport when the keyboard opens (iOS Safari, and Chrome's default resizes-visual), which
// would leave the pinned Send bar and the lower rows behind the keyboard. So while a keyboard is up:
//   - the full-screen form follows the visual viewport (lib/client/visual-viewport.ts followKeyboard, the
//     helper every sheet uses: `data-kb` plus --lp-vv-top / --lp-vv-h / --lp-vv-under, read by
//     request-form.css), so Send sits just above the keyboard;
//   - the focused field's row (its Last seen or Gender chips and error line included) is scrolled into
//     view inside the form's own scroller, never the page behind it.
// Nothing happens without a keyboard (desktop, hardware keyboards, tests), and DOM writes skip React.
import { useEffect, type RefObject } from 'react';
import { followKeyboard, revealDelta } from '@/lib/client/visual-viewport';

/** Space kept between the focused row and the edges of the visible part of the form. */
const REVEAL_MARGIN_PX = 12;

export function useKeyboardFit(rootRef: RefObject<HTMLElement | null>, scrollRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    const scroller = scrollRef.current;
    if (!root || !scroller) return;
    const vv = window.visualViewport;
    let frame = 0;
    // The form follows the visual viewport (also while someone scrolls with the keyboard up, leaving their
    // scroll position alone).
    const stop = followKeyboard(root);

    const reveal = () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !scroller.contains(active)) return;
      const row = active.closest<HTMLElement>('.lp-rf-ls, .lp-rf-field') ?? active;
      const delta = revealDelta(scroller.getBoundingClientRect(), row.getBoundingClientRect(), REVEAL_MARGIN_PX);
      if (delta !== 0) scroller.scrollBy({ top: delta });
    };

    // Measure two frames on, after the new height (and any chips the focus showed) are laid out.
    const revealSoon = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(reveal);
      });
    };

    scroller.addEventListener('focusin', revealSoon);
    vv?.addEventListener('resize', revealSoon);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('focusin', revealSoon);
      vv?.removeEventListener('resize', revealSoon);
      stop();
    };
  }, [rootRef, scrollRef]);
}
