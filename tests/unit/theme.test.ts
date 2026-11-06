// The pre-paint THEME_SCRIPT and BRAND_HIDDEN_SCRIPT (inlined with the CSP nonce in app/layout.tsx), run in a
// bare VM context.
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BRAND_HIDDEN_ATTR, BRAND_HIDDEN_SCRIPT, BRAND_HIDDEN_STORAGE_KEY } from '@/lib/brand-pref';
import { THEME_SCRIPT, THEME_STORAGE_KEY } from '@/lib/theme';

function run(storage: 'throws' | Record<string, string>, systemDark: boolean) {
  const classes = new Set<string>(['light']);
  const root = {
    classList: { add: (c: string) => classes.add(c), remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)) },
    style: { colorScheme: '' },
  };
  const context: Record<string, unknown> = {
    window: { matchMedia: (q: string) => ({ matches: systemDark && q === '(prefers-color-scheme: dark)' }) },
    document: { documentElement: root },
  };
  Object.defineProperty(context, 'localStorage', {
    get() {
      if (storage === 'throws') throw new Error('SecurityError: storage is blocked');
      return { getItem: (k: string) => storage[k] ?? null };
    },
  });
  runInNewContext(THEME_SCRIPT, context);
  return { classes: [...classes], colorScheme: root.style.colorScheme };
}

describe('THEME_SCRIPT', () => {
  it('applies the stored choice', () => {
    expect(run({ [THEME_STORAGE_KEY]: 'light' }, true)).toEqual({ classes: ['light'], colorScheme: 'light' });
    expect(run({ [THEME_STORAGE_KEY]: 'dark' }, false)).toEqual({ classes: ['dark'], colorScheme: 'dark' });
  });

  it('falls back to Auto (the system setting) when localStorage throws', () => {
    expect(run('throws', true)).toEqual({ classes: ['dark'], colorScheme: 'dark' });
    expect(run('throws', false)).toEqual({ classes: ['light'], colorScheme: 'light' });
  });

  it('stays tiny', () => {
    expect(THEME_SCRIPT.length).toBeLessThan(400);
  });
});

// The brand row hidden with its X on this device (F1.1), read before paint for the desk's server-drawn copy
// (lib/brand-pref.ts; inlined after THEME_SCRIPT in the same nonce'd script).
function runBrand(storage: 'throws' | Record<string, string>) {
  const attributes = new Map<string, string>();
  const context: Record<string, unknown> = {
    document: { documentElement: { setAttribute: (k: string, v: string) => attributes.set(k, v) } },
  };
  Object.defineProperty(context, 'localStorage', {
    get() {
      if (storage === 'throws') throw new Error('SecurityError: storage is blocked');
      return { getItem: (k: string) => storage[k] ?? null };
    },
  });
  runInNewContext(BRAND_HIDDEN_SCRIPT, context);
  return [...attributes.keys()];
}

describe('BRAND_HIDDEN_SCRIPT', () => {
  it('marks <html data-brand-hidden> only when the row was hidden ("1"), never throwing', () => {
    expect(BRAND_HIDDEN_STORAGE_KEY).toBe('lp-brand-hidden');
    expect(BRAND_HIDDEN_ATTR).toBe('data-brand-hidden');
    expect(runBrand({ [BRAND_HIDDEN_STORAGE_KEY]: '1' })).toEqual([BRAND_HIDDEN_ATTR]);
    expect(runBrand({})).toEqual([]);
    expect(runBrand({ [BRAND_HIDDEN_STORAGE_KEY]: 'yes' })).toEqual([]);
    expect(runBrand('throws')).toEqual([]);
  });

  it('stays tiny', () => {
    expect(BRAND_HIDDEN_SCRIPT.length).toBeLessThan(200);
  });
});
