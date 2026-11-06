// The brand row's "hidden on this device" (v2.2 afternoon, F1.1: its X; the avatar menu's "Show header" brings
// it back). The pref itself lives in lib/client/prefs.ts (`brandHidden`, localStorage `lp-brand-hidden`).
//
// The phone's row is drawn only in the browser, where the pref is known from the first frame. The desk's row
// is drawn on the server (app/page.tsx, so it is there at the first paint), which can't know it: this
// pre-paint script, inlined with the theme script in app/layout.tsx, marks <html data-brand-hidden> so the
// desk's slot stays display: none (components/desk/frame.module.css) until the shell, once hydrated, drops
// it. A hidden row is never drawn, not even for a frame after a reload. Shared by the server layout and the
// client prefs, so it imports nothing.

export const BRAND_HIDDEN_STORAGE_KEY = 'lp-brand-hidden';
export const BRAND_HIDDEN_ATTR = 'data-brand-hidden';

/** Tiny, dependency-free, runs before first paint. Blocked storage: the row shows. */
export const BRAND_HIDDEN_SCRIPT = `(function(){try{if(localStorage.getItem(${JSON.stringify(BRAND_HIDDEN_STORAGE_KEY)})==='1')document.documentElement.setAttribute(${JSON.stringify(BRAND_HIDDEN_ATTR)},'')}catch(e){}})();`;

/**
 * Keeps <html data-brand-hidden> in step with the pref (the X, Show header, another tab's change), as the
 * pre-paint script set it. A no-op without a DOM.
 */
export function markBrandHidden(hidden: boolean): void {
  const root = typeof document === 'undefined' ? undefined : document.documentElement;
  if (!root || typeof root.toggleAttribute !== 'function') return;
  root.toggleAttribute(BRAND_HIDDEN_ATTR, hidden);
}
