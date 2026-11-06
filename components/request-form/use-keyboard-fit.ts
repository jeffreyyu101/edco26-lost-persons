'use client';
// The request form with the on-screen keyboard up. Every group is open, so the form scrolls. Phones keep
// the layout viewport when the keyboard opens (iOS Safari, and Chrome's default resizes-visual), which
// would leave the pinned Send bar and the lower rows behind the keyboard. So while a keyboard is up:
//   - the full-screen form follows the visual viewport (`data-kb` plus --lp-rf-vv-top / --lp-rf-vv-h, read
//     by request-form.css), so Send sits just above the keyboard;
//   - the focused field's row (its Last seen or Gender chips and error line included) is scrolled into
//     view inside the form's own scroller, never the page behind it.
// Nothing happens without a keyboard (desktop, hardware keyboards, tests), and DOM writes skip React.
import { useEffect, type RefObject } from 'react';
import { keyboardOpen, revealDelta } from './form-logic';

/** Space kept between the focused row and the edges of the visible part of the form. */
const REVEAL_MARGIN_PX = 12;

export function useKeyboardFit(rootRef: RefObject<HTMLElement | null>, scrollRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    const scroller = scrollRef.current;
    if (!root || !scroller) return;
    const vv = window.visualViewport;
    let frame = 0;

    const fit = () => {
      if (vv && keyboardOpen(window.innerHeight, vv.height, vv.scale)) {
        root.style.setProperty('--lp-rf-vv-top', `${Math.round(vv.offsetTop)}px`);
        root.style.setProperty('--lp-rf-vv-h', `${Math.round(vv.height)}px`);
        root.dataset.kb = '';
      } else if (root.dataset.kb !== undefined) {
        delete root.dataset.kb;
        root.style.removeProperty('--lp-rf-vv-top');
        root.style.removeProperty('--lp-rf-vv-h');
      }
    };

    const reveal = () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !scroller.contains(active)) return;
      const row = active.closest<HTMLElement>('.lp-rf-ls, .lp-rf-field') ?? active;
      const delta = revealDelta(scroller.getBoundingClientRect(), row.getBoundingClientRect(), REVEAL_MARGIN_PX);
      if (delta !== 0) scroller.scrollBy({ top: delta });
    };

    // Fit first, then measure on the next frame, after the new height (and any chips the focus showed)
    // are laid out.
    const fitAndReveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        fit();
        frame = requestAnimationFrame(reveal);
      });
    };
    // The visual viewport also pans while someone scrolls with the keyboard up: follow it, but leave
    // their scroll position alone.
    const followPan = () => fit();

    scroller.addEventListener('focusin', fitAndReveal);
    vv?.addEventListener('resize', fitAndReveal);
    vv?.addEventListener('scroll', followPan);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('focusin', fitAndReveal);
      vv?.removeEventListener('resize', fitAndReveal);
      vv?.removeEventListener('scroll', followPan);
      delete root.dataset.kb;
      root.style.removeProperty('--lp-rf-vv-top');
      root.style.removeProperty('--lp-rf-vv-h');
    };
  }, [rootRef, scrollRef]);
}
