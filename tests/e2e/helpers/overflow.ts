// Overflow probe for the F3 screens (Brian: "no element wider than its container, nothing outside the
// viewport"). Walks every rendered element under `root`: none may stick out of the viewport unless an
// ancestor clips or scrolls it (the quick-line pills scroll sideways on purpose), none may be wider than its
// parent unless that parent scrolls, and the page itself never scrolls sideways.
import { expect, type Page } from '@playwright/test';

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

export async function expectNoOverflow(page: Page, rootSelector: string): Promise<void> {
  await expect.poll(async () => (await page.locator(rootSelector).count()) > 0, { timeout: 10_000 }).toBe(true);
  expect(await overflowFindings(page, rootSelector)).toEqual([]);
}

/** The widths every new F3 screen is checked at. */
export const OVERFLOW_WIDTHS = [375, 390, 820, 1180, 1440] as const;
