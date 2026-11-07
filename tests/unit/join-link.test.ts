// Team join link, client side (lib/join-link.ts, J1): the pre-paint JOIN_LINK_SCRIPT and captureJoinCode()
// take `#join=<code>` out of the address bar on every page, keep the code in sessionStorage on /signin
// only, and never touch localStorage, cookies or the URL otherwise. Both run against the same cases. The
// script also handles a fragment-only navigation (the link opened in a tab already on that page): `hashchange`.
import { describe, expect, it } from 'vitest';
import { JOIN_CODE_MAX, JOIN_LINK_SCRIPT, JOIN_STORAGE_KEY, captureJoinCode, forgetJoinCode, readJoinCode, type JoinWindow } from '@/lib/join-link';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  constructor(private readonly blocked = false) {}
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    if (this.blocked) throw new Error('SecurityError');
    return this.map.get(key) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    if (this.blocked) throw new Error('SecurityError');
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    if (this.blocked) throw new Error('SecurityError');
    this.map.set(key, String(value));
  }
}

interface Fake extends JoinWindow {
  replaced: Array<{ state: unknown; url: string | null | undefined }>;
  sessionStorage: MemoryStorage;
  /** Listeners the script registered, by event type. */
  listeners: Map<string, Array<() => void>>;
}

function fakeWindow(href: string, { blocked = false, state = null as unknown } = {}): Fake {
  const url = new URL(href, 'https://lp.example');
  const replaced: Fake['replaced'] = [];
  const location = { pathname: url.pathname, search: url.search, hash: url.hash };
  return {
    location,
    history: {
      state,
      replaceState(data: unknown, _unused: string, next?: string | null) {
        replaced.push({ state: data, url: next });
        const u = new URL(next ?? href, 'https://lp.example');
        Object.assign(location, { pathname: u.pathname, search: u.search, hash: u.hash });
      },
    } as JoinWindow['history'],
    sessionStorage: new MemoryStorage(blocked),
    replaced,
    listeners: new Map(),
  };
}

/** The address bar moves to `href` without a reload (only the fragment changed), then `hashchange` fires. */
function navigateFragment(win: Fake, href: string): void {
  const u = new URL(href, 'https://lp.example');
  Object.assign(win.location, { pathname: u.pathname, search: u.search, hash: u.hash });
  for (const listener of win.listeners.get('hashchange') ?? []) listener();
}

/** Runs the inlined pre-paint script against a fake window (the names it reads are its globals). */
function runScript(win: Fake): void {
  const addEventListener = (type: string, listener: () => void) => {
    win.listeners.set(type, [...(win.listeners.get(type) ?? []), listener]);
  };
  new Function('location', 'history', 'sessionStorage', 'URLSearchParams', 'addEventListener', JOIN_LINK_SCRIPT)(
    win.location,
    win.history,
    win.sessionStorage,
    URLSearchParams,
    addEventListener,
  );
}

const stored = (win: Fake) => {
  try {
    return win.sessionStorage.getItem(JOIN_STORAGE_KEY);
  } catch {
    return null;
  }
};

type Case = [label: string, href: string, kept: string | null, url: string | null];
const CASES: Case[] = [
  ['/signin#join=…: kept, fragment removed', '/signin#join=abc_DEF-123', 'abc_DEF-123', '/signin'],
  ['keeps ?next= when removing the fragment', '/signin?next=%2F%3Fview%3Dmine#join=abc', 'abc', '/signin?next=%2F%3Fview%3Dmine'],
  ['another parameter with it: the whole fragment goes', '/signin#x=1&join=abc', 'abc', '/signin'],
  ['percent-encoded code is decoded', '/signin#join=a%2Fb', 'a/b', '/signin'],
  ['signed in (the app page): removed, not kept', '/#join=abc', null, '/'],
  ['the app with a view: removed, not kept', '/?view=mine#join=abc', null, '/?view=mine'],
  ['empty code: removed, nothing kept', '/signin#join=', null, '/signin'],
  ['blank code: removed, nothing kept', '/signin#join=%20%20', null, '/signin'],
  [`over ${JOIN_CODE_MAX} characters: removed, nothing kept`, `/signin#join=${'x'.repeat(JOIN_CODE_MAX + 1)}`, null, '/signin'],
  ['no join parameter: untouched', '/signin#other=1', null, null],
  ['no fragment: untouched', '/signin', null, null],
];

function runCapture(win: Fake): void {
  captureJoinCode(win);
}

const RUNNERS: Array<[name: string, run: (win: Fake) => void]> = [
  ['JOIN_LINK_SCRIPT (pre-paint)', runScript],
  ['captureJoinCode()', runCapture],
];

describe.each(RUNNERS)('%s', (_name, run) => {
  it.each(CASES)('%s', (_label, href, kept, url) => {
    const win = fakeWindow(href);
    run(win);
    expect(stored(win)).toBe(kept);
    if (url === null) expect(win.replaced).toHaveLength(0);
    else {
      expect(win.replaced.map((r) => r.url)).toEqual([url]);
      expect(win.location.hash).toBe('');
    }
  });

  it('blocked storage: the fragment is still removed and nothing throws', () => {
    const win = fakeWindow('/signin#join=abc', { blocked: true });
    expect(() => run(win)).not.toThrow();
    expect(win.replaced.map((r) => r.url)).toEqual(['/signin']);
  });

  it('is idempotent: a second run keeps the code and replaces nothing', () => {
    const win = fakeWindow('/signin#join=abc');
    run(win);
    run(win);
    expect(stored(win)).toBe('abc');
    expect(win.replaced).toHaveLength(1);
  });
});

describe('JOIN_LINK_SCRIPT, the link opened in a tab already on the page (no reload, only hashchange)', () => {
  it.each(CASES)('%s', (_label, href, kept, url) => {
    const page = new URL(href, 'https://lp.example');
    const win = fakeWindow(page.pathname + page.search);
    runScript(win);
    expect(win.replaced).toHaveLength(0);
    navigateFragment(win, href);
    expect(stored(win)).toBe(kept);
    if (url === null) expect(win.replaced).toHaveLength(0);
    else {
      expect(win.replaced.map((r) => r.url)).toEqual([url]);
      expect(win.location.hash).toBe('');
    }
  });

  it('a second link in the same tab replaces the kept code', () => {
    const win = fakeWindow('/signin#join=first');
    runScript(win);
    navigateFragment(win, '/signin#join=second');
    expect(stored(win)).toBe('second');
    expect(win.replaced.map((r) => r.url)).toEqual(['/signin', '/signin']);
    expect(captureJoinCode(win)).toBe('second');
  });

  it('a page without addEventListener still runs the first pass', () => {
    const win = fakeWindow('/signin#join=abc');
    new Function('location', 'history', 'sessionStorage', 'URLSearchParams', 'addEventListener', JOIN_LINK_SCRIPT)(
      win.location,
      win.history,
      win.sessionStorage,
      URLSearchParams,
      undefined,
    );
    expect(stored(win)).toBe('abc');
    expect(win.location.hash).toBe('');
  });
});

describe('JOIN_LINK_SCRIPT', () => {
  it('keeps the history state it found (Next restores back / forward from it)', () => {
    const state = { __NA: true };
    const win = fakeWindow('/signin#join=abc', { state });
    runScript(win);
    expect(win.replaced[0]?.state).toBe(state);
  });

  it('never uses localStorage, cookies or the URL to keep the code', () => {
    expect(JOIN_LINK_SCRIPT).not.toMatch(/localStorage|cookie|pushState|location\.(href|assign|replace)|indexedDB/);
    expect(JOIN_LINK_SCRIPT).toContain('sessionStorage');
  });
});

describe('captureJoinCode', () => {
  it('passes a fresh state to replaceState (A26) and returns the kept code', () => {
    const win = fakeWindow('/signin#join=abc', { state: { __NA: true } });
    expect(captureJoinCode(win)).toBe('abc');
    expect(win.replaced[0]?.state).toBeNull();
  });

  it('returns a code the pre-paint script kept', () => {
    const win = fakeWindow('/signin#join=from-script');
    runScript(win);
    expect(win.location.hash).toBe('');
    expect(captureJoinCode(win)).toBe('from-script');
  });

  it('returns null without a window (server render)', () => {
    expect(captureJoinCode(null)).toBeNull();
    expect(readJoinCode(null)).toBeNull();
    expect(() => forgetJoinCode(null)).not.toThrow();
  });
});

describe('readJoinCode / forgetJoinCode', () => {
  it('reads and forgets the kept code', () => {
    const win = fakeWindow('/signin');
    win.sessionStorage.setItem(JOIN_STORAGE_KEY, 'abc');
    expect(readJoinCode(win)).toBe('abc');
    forgetJoinCode(win);
    expect(readJoinCode(win)).toBeNull();
    expect(win.sessionStorage.length).toBe(0);
  });

  it('blocked storage reads as no code and forgetting never throws', () => {
    const win = fakeWindow('/signin', { blocked: true });
    expect(readJoinCode(win)).toBeNull();
    expect(() => forgetJoinCode(win)).not.toThrow();
  });

  it('ignores an over-long kept value', () => {
    const win = fakeWindow('/signin');
    win.sessionStorage.setItem(JOIN_STORAGE_KEY, 'x'.repeat(JOIN_CODE_MAX + 1));
    expect(readJoinCode(win)).toBeNull();
  });
});
