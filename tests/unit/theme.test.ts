// The pre-paint THEME_SCRIPT (inlined with the CSP nonce in app/layout.tsx), run in a bare VM context.
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
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
