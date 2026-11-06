// Accessibility probes for the e2e gates (spec §7 Accessibility): axe-core over the live page, and the
// effective tap target of every control (its box plus any absolutely positioned ::before / ::after that
// extends it, which is how the compact controls get a 44 px hit area without changing their layout).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Locator, type Page } from '@playwright/test';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/** WCAG 2.0 and 2.1, levels A and AA: contrast, names (incl. 2.5.3 label in name), roles, structure. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

export interface AxeFinding {
  rule: string;
  target: string;
  summary: string;
}

/**
 * Runs axe-core on the whole document and returns one line per failing node. Needs a context with
 * `bypassCSP: true`: the production CSP (rightly) refuses the injected script.
 */
export async function axeViolations(page: Page): Promise<AxeFinding[]> {
  return axeViolationsWith(page, {});
}

export interface AxeOptions {
  /** Only these rules (default: every rule with the WCAG 2.0/2.1 A + AA tags). */
  rules?: string[];
  /** CSS selector of elements to take out of the page while axe runs (restored afterwards). */
  hide?: string;
}

/**
 * Text that a transparent stretched button lies over (a card that opens the profile) is reported by axe
 * as "incomplete" for contrast, never checked. The overlay is transparent, so hiding it while axe looks at
 * colours changes nothing it sees and lets every word on the card be checked.
 */
export async function axeContrastUnder(page: Page, overlay: string): Promise<AxeFinding[]> {
  return axeViolationsWith(page, { rules: ['color-contrast'], hide: overlay });
}

export async function axeViolationsWith(page: Page, opts: AxeOptions): Promise<AxeFinding[]> {
  const loaded = await page.evaluate(() => typeof (window as unknown as { axe?: unknown }).axe !== 'undefined');
  if (!loaded) await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(
    async ({ tags, rules, hide }) => {
      type AxeResult = {
        violations: Array<{ id: string; nodes: Array<{ target: unknown[]; failureSummary?: string }> }>;
      };
      const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<AxeResult> } }).axe;
      const hidden = hide ? Array.from(document.querySelectorAll<HTMLElement>(hide)) : [];
      const before = hidden.map((el) => el.style.display);
      for (const el of hidden) el.style.display = 'none';
      try {
        const result = await axe.run(document, {
          runOnly: rules ? { type: 'rule', values: rules } : { type: 'tag', values: tags },
          resultTypes: ['violations'],
        });
        return result.violations.flatMap((v) =>
          v.nodes.map((n) => ({
            rule: v.id,
            target: n.target.map(String).join(' '),
            summary: (n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 300),
          })),
        );
      } finally {
        hidden.forEach((el, i) => {
          el.style.display = before[i] ?? '';
        });
      }
    },
    { tags: [...AXE_TAGS], rules: opts.rules ?? null, hide: opts.hide ?? null },
  );
}

export interface SmallTarget {
  name: string;
  width: number;
  height: number;
}

/**
 * Every visible, enabled control in `scope` whose effective tap target is under `min` px in either
 * direction. A control inside another control (a stretched card button's content) is measured on its own.
 */
export async function smallTargets(page: Page, scope = 'body', min = 44): Promise<SmallTarget[]> {
  return page.evaluate(
    ({ scope, min }) => {
      const SELECTOR = [
        'button',
        'a[href]',
        '[role="button"]',
        '[role="radio"]',
        '[role="checkbox"]',
        '[role="switch"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="menuitemradio"]',
        'summary',
      ].join(',');
      const px = (v: string): number | null => (v === 'auto' || v === '' ? null : Number.parseFloat(v));
      const out: Array<{ name: string; width: number; height: number }> = [];
      const root = document.querySelector(scope);
      if (!root) return out;
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(SELECTOR))) {
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue;
        if (el.closest('[aria-hidden="true"], [inert]')) continue;
        if ((el as HTMLButtonElement).disabled) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // Visually hidden helpers (1 px clipped) are not tap targets.
        if (r.width <= 1 || r.height <= 1) continue;
        let left = r.left;
        let top = r.top;
        let right = r.right;
        let bottom = r.bottom;
        if (style.position !== 'static') {
          // The padding box is the containing block of an absolutely positioned pseudo-element.
          const pl = r.left + (px(style.borderLeftWidth) ?? 0);
          const pt = r.top + (px(style.borderTopWidth) ?? 0);
          const pr = r.right - (px(style.borderRightWidth) ?? 0);
          const pb = r.bottom - (px(style.borderBottomWidth) ?? 0);
          for (const pseudo of ['::before', '::after']) {
            const ps = getComputedStyle(el, pseudo);
            if (ps.content === 'none' || ps.content === 'normal' || ps.display === 'none') continue;
            if (ps.position !== 'absolute' || ps.pointerEvents === 'none') continue;
            const t = px(ps.top);
            const l = px(ps.left);
            const rr = px(ps.right);
            const b = px(ps.bottom);
            if (t === null || l === null || rr === null || b === null) continue;
            left = Math.min(left, pl + l);
            top = Math.min(top, pt + t);
            right = Math.max(right, pr - rr);
            bottom = Math.max(bottom, pb - b);
          }
        }
        const width = Math.round((right - left) * 10) / 10;
        const height = Math.round((bottom - top) * 10) / 10;
        if (width + 0.5 >= min && height + 0.5 >= min) continue;
        const name =
          el.getAttribute('aria-label') ||
          (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) ||
          el.getAttribute('data-testid') ||
          el.outerHTML.slice(0, 80);
        out.push({ name, width, height });
      }
      return out;
    },
    { scope, min },
  );
}

export interface Overlap {
  /** The control whose tap area reaches over… */
  from: string;
  /** …this other control's own box. */
  over: string;
}

/**
 * Controls whose effective tap target (box + hit-area pseudo-element) reaches over another visible
 * control's own box, so a tap there would go to the wrong one. Layered controls by design (a card's
 * stretched button under its action buttons: one box contains the other) are not overlaps.
 */
export async function overlappingTargets(page: Page, scope = 'body'): Promise<Overlap[]> {
  return page.evaluate((scope) => {
    const SELECTOR = 'button, a[href], [role="button"], [role="radio"], [role="checkbox"], [role="switch"], [role="tab"], input:not([type="hidden"]), textarea, select';
    const px = (v: string): number | null => (v === 'auto' || v === '' ? null : Number.parseFloat(v));
    const root = document.querySelector(scope);
    if (!root) return [];
    type Box = { left: number; top: number; right: number; bottom: number };
    // Fixed and sticky bars (header, sticky actions, the New request button) float over the scrolling
    // content by design: only controls in the same layer are compared.
    const layerOf = (el: Element): Element | null => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        const p = getComputedStyle(n).position;
        if (p === 'fixed' || p === 'sticky') return n;
      }
      return null;
    };
    // The part of the page a control can show in: its scrolling / clipping ancestors' boxes, up to its
    // fixed layer. A field half scrolled out of a form's scroller is cut off at the scroller's edge, so the
    // part under the pinned footer is neither seen nor tapped.
    const clipOf = (el: Element): Box => {
      const box: Box = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
      if (getComputedStyle(el).position === 'fixed') return box;
      for (let n: Element | null = el.parentElement; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
          const r = n.getBoundingClientRect();
          box.left = Math.max(box.left, r.left);
          box.top = Math.max(box.top, r.top);
          box.right = Math.min(box.right, r.right);
          box.bottom = Math.min(box.bottom, r.bottom);
        }
        if (s.position === 'fixed') break;
      }
      return box;
    };
    const clip = (a: Box, c: Box): Box => ({
      left: Math.max(a.left, c.left),
      top: Math.max(a.top, c.top),
      right: Math.min(a.right, c.right),
      bottom: Math.min(a.bottom, c.bottom),
    });
    const items: Array<{ el: HTMLElement; name: string; own: Box; hit: Box; layer: Element | null }> = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(SELECTOR))) {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue;
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      const own = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      const hit = { ...own };
      if (style.position !== 'static') {
        const pl = r.left + (px(style.borderLeftWidth) ?? 0);
        const pt = r.top + (px(style.borderTopWidth) ?? 0);
        const pr = r.right - (px(style.borderRightWidth) ?? 0);
        const pb = r.bottom - (px(style.borderBottomWidth) ?? 0);
        for (const pseudo of ['::before', '::after']) {
          const ps = getComputedStyle(el, pseudo);
          if (ps.content === 'none' || ps.content === 'normal' || ps.display === 'none') continue;
          if (ps.position !== 'absolute' || ps.pointerEvents === 'none') continue;
          const t = px(ps.top);
          const l = px(ps.left);
          const rr = px(ps.right);
          const b = px(ps.bottom);
          if (t === null || l === null || rr === null || b === null) continue;
          hit.left = Math.min(hit.left, pl + l);
          hit.top = Math.min(hit.top, pt + t);
          hit.right = Math.max(hit.right, pr - rr);
          hit.bottom = Math.max(hit.bottom, pb - b);
        }
      }
      // Only controls a tap can reach: not covered (at their centre) by a popover, sheet or other layer.
      const cx = Math.min(Math.max((r.left + r.right) / 2, 0), window.innerWidth - 1);
      const cy = Math.min(Math.max((r.top + r.bottom) / 2, 0), window.innerHeight - 1);
      const top = document.elementFromPoint(cx, cy);
      if (!top || !(el === top || el.contains(top) || top.contains(el))) continue;
      const name =
        el.getAttribute('aria-label') ||
        (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 50) ||
        el.getAttribute('data-testid') ||
        el.tagName.toLowerCase();
      const c = clipOf(el);
      items.push({ el, name, own: clip(own, c), hit: clip(hit, c), layer: layerOf(el) });
    }
    const contains = (a: Box, b: Box) => a.left <= b.left + 1 && a.top <= b.top + 1 && a.right >= b.right - 1 && a.bottom >= b.bottom - 1;
    const area = (a: Box, b: Box) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const out: Array<{ from: string; over: string }> = [];
    for (const a of items) {
      for (const b of items) {
        if (a === b || a.layer !== b.layer || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        if (contains(a.own, b.own) || contains(b.own, a.own)) continue;
        // A label wrapping its input, or an input inside a field wrapper, is one control.
        if (a.el.closest('label')?.contains(b.el) || b.el.closest('label')?.contains(a.el)) continue;
        // More than a 1 px sliver (rounding) of b's own box under a's tap area.
        const shrunk = { left: b.own.left + 1, top: b.own.top + 1, right: b.own.right - 1, bottom: b.own.bottom - 1 };
        if (area(a.hit, shrunk) > 0) out.push({ from: a.name, over: b.name });
      }
    }
    return out;
  }, scope);
}

/**
 * Text on the brand card (components/list/BrandCard.tsx) lies on a gradient with two glows and faint rings,
 * which axe can only mark "needs review". So this measures it: the card is captured with its text made
 * transparent, and each run of text is compared with every pixel behind its line box. Returns one line per
 * run under 4.5:1 (the bar for small text, applied to the title too). `card` is the phone list's card by
 * default; the desk's is inside its brand slot (data-testid="desk-brand").
 */
export async function brandContrast(page: Page, card: Locator = page.getByTestId('brand-card')): Promise<string[]> {
  const layout = await card.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const runs: Array<{ text: string; color: string; x: number; y: number; w: number; h: number }> = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? '').trim();
      if (!text) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const color = getComputedStyle(n.parentElement!).color;
      for (const r of Array.from(range.getClientRects())) runs.push({ text, color, x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height });
    }
    return { width: box.width, runs };
  });
  expect(layout.runs.length).toBeGreaterThanOrEqual(5);
  const hide = await page.addStyleTag({ content: '[data-testid="brand-card"] * { color: transparent !important; }' });
  const png = await card.screenshot({ animations: 'disabled' });
  await hide.evaluate((el) => (el as Element).remove());
  return page.evaluate(
    async ({ data, width, runs }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const scale = img.width / width;
      const channel = (v: number) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (r: number, g: number, b: number) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      const out: string[] = [];
      for (const run of runs) {
        const [r, g, b] = (run.color.match(/[\d.]+/g) ?? []).map(Number) as [number, number, number];
        const text = luminance(r, g, b);
        const x0 = Math.max(0, Math.floor(run.x * scale));
        const y0 = Math.max(0, Math.floor(run.y * scale));
        const x1 = Math.min(img.width, Math.ceil((run.x + run.w) * scale));
        const y1 = Math.min(img.height, Math.ceil((run.y + run.h) * scale));
        const px = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
        let worst = Infinity;
        for (let i = 0; i < px.length; i += 4) {
          const back = luminance(px[i]!, px[i + 1]!, px[i + 2]!);
          worst = Math.min(worst, (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05));
        }
        if (worst < 4.5) out.push(`"${run.text}" ${run.color}: ${worst.toFixed(2)}:1`);
      }
      return out;
    },
    { data: png.toString('base64'), width: layout.width, runs: layout.runs },
  );
}
