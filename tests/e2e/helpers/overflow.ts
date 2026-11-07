// Overflow check for a screen (F4 rule: every new screen gets one at 375, 390, 820, 1180 and 1440 px): no
// element wider than its container, nothing outside the viewport, and no sideways page scroll. Visually
// hidden screen-reader text (clipped to 1 px) and zero-size boxes are skipped; text cut with an ellipsis stays
// inside its box, so it passes.
import { expect, type Locator, type Page } from '@playwright/test';

export const OVERFLOW_WIDTHS = [375, 390, 820, 1180, 1440] as const;

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

export async function expectNoOverflow(page: Page, root: Locator, label: string): Promise<void> {
  await expect(root).toBeVisible();
  const problems = await overflowProblems(root);
  expect(problems, `${label} at ${page.viewportSize()?.width ?? '?'} px`).toEqual([]);
}
