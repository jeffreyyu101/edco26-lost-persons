// The desk sidebar's width chosen on this device (shadcn/ui Sidebar, variant "inset", Brian 2026-11-08): expanded
// (256 px, labels and counts) or collapsed to its icons (64 px), kept once someone uses its toggle (the top bar's
// button, the sidebar's edge, Cmd+B / Ctrl+B). With no choice the width decides (components/desk/sidebar-model.ts).
//
// The desk's columns are drawn by CSS from the server's first paint (components/desk/frame.module.css), which
// can't know a choice kept in localStorage: this pre-paint script, inlined with the theme script in
// app/layout.tsx, marks <html data-desk-sidebar="expanded | collapsed"> before the first frame, so the column has
// its width from the start. Shared by the server layout and the desk chunk (components/desk/sidebar-state.ts), so
// it imports nothing.

export const SIDEBAR_STORAGE_KEY = 'lp-desk-sidebar';
export const SIDEBAR_ATTR = 'data-desk-sidebar';

export type SidebarPref = 'expanded' | 'collapsed';

/** A stored value, or null for anything else (nothing chosen yet, or a value from another build). */
export function parseSidebarPref(raw: unknown): SidebarPref | null {
  return raw === 'expanded' || raw === 'collapsed' ? raw : null;
}

/** Tiny, dependency-free, runs before first paint. Blocked storage: no attribute, the width decides. */
export const SIDEBAR_SCRIPT = `(function(){try{var v=localStorage.getItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)});if(v==='expanded'||v==='collapsed')document.documentElement.setAttribute(${JSON.stringify(SIDEBAR_ATTR)},v)}catch(e){}})();`;
