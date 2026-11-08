// Overflow probe for the F3 screens (Brian: "no element wider than its container, nothing outside the
// viewport"). Walks every rendered element under `root`: none may stick out of the viewport unless an
// ancestor clips or scrolls it (the quick-line pills wrap since 2026-11-08, so they get no pass), none may be wider than its
// parent unless that parent scrolls, and the page itself never scrolls sideways.
//
// Overflow check for a screen (F4 rule: every new screen gets one at 375, 390, 820, 1180 and 1440 px): no
// element wider than its container, nothing outside the viewport, and no sideways page scroll. Visually
// hidden screen-reader text (clipped to 1 px) and zero-size boxes are skipped; text cut with an ellipsis stays
// inside its box, so it passes.

import { expect, type Locator, type Page } from '@playwright/test';

/** The widths every new screen is checked at (F3 and F4 rule). */
export const OVERFLOW_WIDTHS = [375, 390, 820, 1180, 1440] as const;

// F3's probe: every element under the elements matching a CSS selector.
export async function overflowFindings(page: Page, rootSelector: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
    const roots = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const clips = (el: Element) => {
      const s = getComputedStyle(el);
      return ['auto', 'scroll', 'hidden', 'clip'].includes(s.overflowX);
    };
    const name = (el: Element) => {
      const h = el as HTMLElement;
      return `${el.tagName.toLowerCase()}${h.dataset.testid ? `[data-testid=${h.dataset.testid}]` : ''}${typeof h.className === 'string' && h.className ? `.${h.className.split(' ')[0]}` : ''}`;
    };
    for (const root of roots) {
      for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.position === 'fixed') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        // Visually hidden helpers (1 px, clipped) are not on screen.
        if (s.clipPath === 'inset(50%)' || (r.width <= 1 && r.height <= 1)) continue;
        let clipped = false;
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          if (clips(a)) {
            clipped = true;
            break;
          }
        }
        if (!clipped && (r.left < -1 || r.right > vw + 1)) out.push(`${name(el)} outside the viewport (${Math.round(r.left)}..${Math.round(r.right)} of ${vw})`);
        const parent = el.parentElement;
        if (parent && !clips(parent) && s.position !== 'absolute') {
          const p = parent.getBoundingClientRect();
          if (r.width > p.width + 1) out.push(`${name(el)} wider than ${name(parent)} (${Math.round(r.width)} > ${Math.round(p.width)})`);
        }
      }
    }
    return [...new Set(out)].slice(0, 20);
  }, rootSelector);
}


// F4's probe: one Locator's subtree, with a label for the failure message.
export interface OverflowProblem {
  what: string;
  issue: string;
}

/** Problems inside `root` (its descendants against their parents and the viewport). */
export async function overflowProblems(root: Locator): Promise<OverflowProblem[]> {
  return root.evaluate((el) => {
    const out: Array<{ what: string; issue: string }> = [];
    const vw = document.documentElement.clientWidth;
    const name = (e: Element) => {
      const id = e.getAttribute('data-testid');
      const cls = typeof (e as HTMLElement).className === 'string' ? (e as HTMLElement).className.split(' ')[0] : '';
      const text = (e.textContent ?? '').trim().slice(0, 30);
      return `${e.tagName.toLowerCase()}${id ? `[${id}]` : ''}${cls ? `.${cls}` : ''} "${text}"`;
    };
    const hidden = (e: Element) => {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden') return true;
      const r = e.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return true;
      return s.position === 'absolute' && (s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)');
    };
    const all = [el, ...el.querySelectorAll('*')];
    for (const e of all) {
      if (hidden(e) || e.closest('[aria-hidden="true"] svg, svg *')) continue;
      const r = e.getBoundingClientRect();
      if (r.left < -1 || r.right > vw + 1) out.push({ what: name(e), issue: `outside the viewport (${Math.round(r.left)}–${Math.round(r.right)} of ${vw})` });
      const parent = e === el ? null : e.parentElement;
      if (parent && !hidden(parent)) {
        const p = parent.getBoundingClientRect();
        const ps = getComputedStyle(parent);
        const scrolls = /(auto|scroll)/.test(ps.overflowX);
        if (!scrolls && (r.left < p.left - 1 || r.right > p.right + 1)) {
          out.push({ what: name(e), issue: `wider than its container (${Math.round(r.width)} in ${Math.round(p.width)})` });
        }
      }
    }
    if (document.documentElement.scrollWidth > vw + 1) out.push({ what: 'page', issue: `scrolls sideways (${document.documentElement.scrollWidth} > ${vw})` });
    return out;
  });
}


/**
 * No overflow under `root`: a CSS selector (F3's probe, every match) or a Locator (F4's probe, with `label`
 * naming the screen in the failure message).
 */
export async function expectNoOverflow(page: Page, root: string | Locator, label?: string): Promise<void> {
  if (typeof root === 'string') {
    await expect.poll(async () => (await page.locator(root).count()) > 0, { timeout: 10_000 }).toBe(true);
    expect(await overflowFindings(page, root)).toEqual([]);
    return;
  }
  await expect(root).toBeVisible();
  const problems = await overflowProblems(root);
  expect(problems, `${label ?? 'screen'} at ${page.viewportSize()?.width ?? '?'} px`).toEqual([]);
}
