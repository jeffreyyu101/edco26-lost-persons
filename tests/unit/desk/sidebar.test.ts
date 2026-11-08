// The desk sidebar (shadcn/ui Sidebar, variant "inset"): collapsed or expanded per width, docked or over the
// content, the toggle, and the choice kept on this device (components/desk/sidebar-model.ts, sidebar-state.ts,
// lib/desk-sidebar-pref.ts). Synthetic only; a fake window stands in for the browser.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { layoutFor } from '@/components/desk/breakpoints';
import { expandedByDefault, sidebarExpanded, sidebarMode, toggled, type SidebarState } from '@/components/desk/sidebar-model';
import { SIDEBAR_ATTR, SIDEBAR_SCRIPT, SIDEBAR_STORAGE_KEY, parseSidebarPref } from '@/lib/desk-sidebar-pref';

const NONE: SidebarState = { pref: null, overlay: false };

describe('sidebar model', () => {
  it('starts expanded from 1280 px and collapsed from 768 to 1279 px', () => {
    for (const width of [1280, 1366, 1440, 1920]) expect(expandedByDefault(layoutFor(width)), `${width}`).toBe(true);
    for (const width of [768, 820, 1023, 1024, 1180, 1279]) expect(expandedByDefault(layoutFor(width)), `${width}`).toBe(false);
    for (const width of [1440, 1280]) expect(sidebarExpanded(NONE, layoutFor(width), false), `${width}`).toBe(true);
    for (const width of [768, 1100, 1279]) expect(sidebarExpanded(NONE, layoutFor(width), false), `${width}`).toBe(false);
    // A request open beside the list changes nothing from 1280 px.
    expect(sidebarExpanded(NONE, layoutFor(1440), true)).toBe(true);
  });

  it('docks where the list and an open request fit beside 256 px, and opens over them where they do not', () => {
    expect(sidebarMode(layoutFor(1440), false)).toBe('docked');
    expect(sidebarMode(layoutFor(1440), true)).toBe('docked');
    expect(sidebarMode(layoutFor(1100), false)).toBe('docked');
    expect(sidebarMode(layoutFor(1100), true)).toBe('overlay');
    expect(sidebarMode(layoutFor(820), false)).toBe('overlay');
    expect(sidebarMode(layoutFor(820), true)).toBe('overlay');
  });

  it('a choice kept on this device wins over the width while docked; over the content it is never open on load', () => {
    expect(sidebarExpanded({ pref: 'collapsed', overlay: false }, 'desktop', false)).toBe(false);
    expect(sidebarExpanded({ pref: 'expanded', overlay: false }, 'laptop', false)).toBe(true);
    // At 1024–1279 with a request open, a kept "expanded" does not squeeze the pane: collapsed until opened over it.
    expect(sidebarExpanded({ pref: 'expanded', overlay: false }, 'laptop', true)).toBe(false);
    expect(sidebarExpanded({ pref: 'expanded', overlay: false }, 'tablet', false)).toBe(false);
    expect(sidebarExpanded({ pref: 'collapsed', overlay: true }, 'tablet', false)).toBe(true);
  });

  it('the toggle flips and keeps the choice when docked, and only opens or closes over the content otherwise', () => {
    expect(toggled(NONE, 'desktop', false)).toEqual({ pref: 'collapsed', overlay: false });
    expect(toggled({ pref: 'collapsed', overlay: false }, 'desktop', false)).toEqual({ pref: 'expanded', overlay: false });
    expect(toggled(NONE, 'laptop', false)).toEqual({ pref: 'expanded', overlay: false });
    expect(toggled(NONE, 'tablet', false)).toEqual({ pref: null, overlay: true });
    expect(toggled({ pref: null, overlay: true }, 'tablet', false)).toEqual({ pref: null, overlay: false });
    expect(toggled({ pref: 'expanded', overlay: false }, 'laptop', true)).toEqual({ pref: 'expanded', overlay: true });
  });
});

describe('the choice kept on this device', () => {
  it('reads only the two values', () => {
    expect(parseSidebarPref('expanded')).toBe('expanded');
    expect(parseSidebarPref('collapsed')).toBe('collapsed');
    for (const v of [null, undefined, '', 'open', 'EXPANDED', 1]) expect(parseSidebarPref(v)).toBeNull();
  });

  it('the pre-paint script marks <html> from storage, and does nothing when storage is empty, odd or blocked', () => {
    const run = (stored: string | null | Error) => {
      const attrs = new Map<string, string>();
      const storage = {
        getItem: (key: string) => {
          if (stored instanceof Error) throw stored;
          return key === SIDEBAR_STORAGE_KEY ? stored : null;
        },
      };
      const document = { documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) } };
      new Function('localStorage', 'document', SIDEBAR_SCRIPT)(storage, document);
      return attrs.get(SIDEBAR_ATTR) ?? null;
    };
    expect(run('collapsed')).toBe('collapsed');
    expect(run('expanded')).toBe('expanded');
    expect(run(null)).toBeNull();
    expect(run('wide')).toBeNull();
    expect(run(new Error('SecurityError'))).toBeNull();
  });
});

/** A fake browser: a window of `width`, an address, localStorage (or one that throws) and <html>'s attributes. */
function fakeBrowser(width: number, opts: { search?: string; blocked?: boolean } = {}) {
  const store = new Map<string, string>();
  const attrs = new Map<string, string>();
  const location = { search: opts.search ?? '', href: `http://localhost/${opts.search ?? ''}` };
  const localStorage = {
    getItem: (k: string) => {
      if (opts.blocked) throw new Error('SecurityError');
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.blocked) throw new Error('QuotaExceededError');
      store.set(k, v);
    },
  };
  const matchMedia = (query: string) => {
    const min = Number(/min-width: (\d+)px/.exec(query)?.[1] ?? 0);
    return { matches: width >= min, addEventListener: () => {}, removeEventListener: () => {} };
  };
  vi.stubGlobal('window', { localStorage, matchMedia, location, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('document', {
    documentElement: {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    },
  });
  return {
    store,
    attrs,
    go(search: string) {
      location.search = search;
      location.href = `http://localhost/${search}`;
    },
  };
}

describe('toggleSidebar (the top bar button, the edge, Cmd+B)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('at 1440: collapses, then expands, keeping each choice in localStorage and on <html>', async () => {
    const b = fakeBrowser(1440);
    const s = await import('@/components/desk/sidebar-state');
    s.toggleSidebar();
    expect(b.store.get(SIDEBAR_STORAGE_KEY)).toBe('collapsed');
    expect(b.attrs.get(SIDEBAR_ATTR)).toBe('collapsed');
    expect(s.sidebarOverlayOpen()).toBe(false);
    s.toggleSidebar();
    expect(b.store.get(SIDEBAR_STORAGE_KEY)).toBe('expanded');
    expect(b.attrs.get(SIDEBAR_ATTR)).toBe('expanded');
  });

  it('a kept choice is read back on the next load', async () => {
    const b = fakeBrowser(1440);
    b.store.set(SIDEBAR_STORAGE_KEY, 'collapsed');
    const s = await import('@/components/desk/sidebar-state');
    expect(s.readSidebarPref()).toBe('collapsed');
    // Expanded again: the stored "collapsed" was the starting point.
    s.toggleSidebar();
    expect(b.store.get(SIDEBAR_STORAGE_KEY)).toBe('expanded');
  });

  it('at 1100 with nothing open: expands docked and keeps it', async () => {
    const b = fakeBrowser(1100);
    const s = await import('@/components/desk/sidebar-state');
    s.toggleSidebar();
    expect(b.store.get(SIDEBAR_STORAGE_KEY)).toBe('expanded');
    expect(s.sidebarOverlayOpen()).toBe(false);
  });

  it('at 820, or at 1100 with a request open: opens over the content, keeps nothing, and closes on Esc or a new address', async () => {
    const b = fakeBrowser(820);
    const s = await import('@/components/desk/sidebar-state');
    s.toggleSidebar();
    expect(s.sidebarOverlayOpen()).toBe(true);
    expect(b.store.has(SIDEBAR_STORAGE_KEY)).toBe(false);
    expect(b.attrs.has(SIDEBAR_ATTR)).toBe(false);
    s.closeSidebarOverlay();
    expect(s.sidebarOverlayOpen()).toBe(false);
    s.toggleSidebar();
    expect(s.sidebarOverlayOpen()).toBe(true);
    // Another view chosen: no longer open (it never comes back on Back).
    b.go('?view=pending');
    expect(s.sidebarOverlayOpen()).toBe(false);

    vi.resetModules();
    const c = fakeBrowser(1100, { search: '?r=5eed0000-0000-4000-8000-000000000001' });
    const t = await import('@/components/desk/sidebar-state');
    t.toggleSidebar();
    expect(t.sidebarOverlayOpen()).toBe(true);
    expect(c.store.has(SIDEBAR_STORAGE_KEY)).toBe(false);
  });

  it('blocked storage: the toggle still works for this page and marks <html>', async () => {
    const b = fakeBrowser(1440, { blocked: true });
    const s = await import('@/components/desk/sidebar-state');
    expect(s.readSidebarPref()).toBeNull();
    s.toggleSidebar();
    expect(b.attrs.get(SIDEBAR_ATTR)).toBe('collapsed');
    s.toggleSidebar();
    expect(b.attrs.get(SIDEBAR_ATTR)).toBe('expanded');
  });
});
