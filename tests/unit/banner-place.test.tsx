// (Phase 3) The alerts banner's remembered place (components/alerts/banner-place.tsx): what a cold load draws before
// /api/push/prefs answers. A minimal browser: localStorage and getComputedStyle only.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BANNER_MEMORY_KEY, BannerPlace, forgetBanner, rememberBanner } from '@/components/alerts/banner-place';

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    getComputedStyle: () => ({ margin: '12px 12px 0px' }),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const el = (h: number) => ({ offsetHeight: h }) as unknown as HTMLElement;

describe('alerts banner place', () => {
  it('nothing remembered: nothing drawn', () => {
    expect(renderToStaticMarkup(<BannerPlace place="list" />)).toBe('');
  });

  it('draws the remembered box of that place only, in the state\'s tint, hidden from screen readers', () => {
    rememberBanner('install', 'list', el(128));
    const html = renderToStaticMarkup(<BannerPlace place="list" />);
    expect(html).toContain('height:128px');
    expect(html).toContain('margin:12px 12px 0px');
    expect(html).toContain('var(--blue-a3)');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-state="install"');
    // Never drawn on the desk table yet: no guess there.
    expect(renderToStaticMarkup(<BannerPlace place="desk-table" />)).toBe('');
    rememberBanner('install', 'desk-table', el(90));
    expect(renderToStaticMarkup(<BannerPlace place="desk-table" />)).toContain('height:90px');
    expect(renderToStaticMarkup(<BannerPlace place="list" />)).toContain('height:128px');
  });

  it('a new state starts over (the other places\' boxes were the old banner\'s); blocked is amber', () => {
    rememberBanner('install', 'list', el(128));
    rememberBanner('install', 'desk-table', el(90));
    rememberBanner('blocked', 'list', el(150));
    expect(renderToStaticMarkup(<BannerPlace place="desk-table" />)).toBe('');
    const html = renderToStaticMarkup(<BannerPlace place="list" />);
    expect(html).toContain('height:150px');
    expect(html).toContain('var(--amber-a3)');
  });

  it('no banner any more: forgotten; a zero-height measure is not remembered; junk in storage draws nothing', () => {
    rememberBanner('off', 'list', el(64));
    forgetBanner();
    expect(store.has(BANNER_MEMORY_KEY)).toBe(false);
    rememberBanner('off', 'list', el(0));
    expect(store.has(BANNER_MEMORY_KEY)).toBe(false);
    store.set(BANNER_MEMORY_KEY, '{"s":"on","at":{"list":{"h":10,"m":"0"}}}');
    expect(renderToStaticMarkup(<BannerPlace place="list" />)).toBe('');
    store.set(BANNER_MEMORY_KEY, 'not json');
    expect(renderToStaticMarkup(<BannerPlace place="list" />)).toBe('');
  });

  it('server render (no window): nothing', () => {
    vi.unstubAllGlobals();
    expect(renderToStaticMarkup(<BannerPlace place="list" />)).toBe('');
  });
});
