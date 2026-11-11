import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BELL_FROM_SERVER_KEY,
  DEFAULT_PREFS,
  PREF_STORAGE_KEYS,
  SESSION_PREF_KEYS,
  clearRememberedIdentity,
  forgetBell,
  forgetBellForOtherStaff,
  markBellFromServer,
  readOldBell,
  readPrefs,
  setBell,
  setBellIntroSeen,
  setBrandHidden,
  setClosedExpanded,
  setLastPost,
  setThemePref,
  subscribePrefs,
  writePref,
  writeRememberedIdentity,
} from '@/lib/client/prefs';
import { createStubStore } from '@/lib/client/store-stub';
import { THEME_STORAGE_KEY } from '@/lib/theme';

// A minimal browser: localStorage, <html> class list and the storage event.
function fakeBrowser() {
  const data = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  };
  const session = new Map<string, string>();
  const sessionStorage = {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, String(v)),
    removeItem: (k: string) => void session.delete(k),
  };
  const classes = new Set<string>();
  const attributes = new Set<string>();
  const documentElement = {
    classList: { add: (c: string) => void classes.add(c), remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)) },
    style: { colorScheme: '' },
    toggleAttribute: (name: string, force: boolean) => {
      if (force) attributes.add(name);
      else attributes.delete(name);
      return force;
    },
  };
  const listeners = new Set<(e: { key: string | null }) => void>();
  const window = {
    localStorage,
    sessionStorage,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener: (type: string, fn: (e: { key: string | null }) => void) => type === 'storage' && listeners.add(fn),
    removeEventListener: (type: string, fn: (e: { key: string | null }) => void) => type === 'storage' && listeners.delete(fn),
  };
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', { documentElement });
  return { data, session, classes, attributes, documentElement, fire: (key: string | null) => listeners.forEach((l) => l({ key })), listeners };
}

describe('prefs (remembered on this phone)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the defaults on the server (no window)', () => {
    expect(readPrefs()).toEqual(DEFAULT_PREFS);
    expect(() => writeRememberedIdentity('Dana Kim', 'Medical')).not.toThrow();
    expect(() => setThemePref('dark')).not.toThrow();
  });

  describe('in a browser', () => {
    let browser: ReturnType<typeof fakeBrowser>;
    beforeEach(() => {
      browser = fakeBrowser();
    });

    it('starts at the defaults', () => {
      expect(readPrefs()).toEqual(DEFAULT_PREFS);
    });

    it('remembers the name and team (as the server stored it) for sign-in, and Change clears them', () => {
      writeRememberedIdentity('  Dana   Kim ', ' GC/HX  - Dispatch');
      expect(readPrefs()).toMatchObject({ rememberedName: 'Dana Kim', rememberedTeam: 'GC/HX - Dispatch' });
      expect(JSON.parse(browser.data.get(PREF_STORAGE_KEYS.identity)!)).toEqual({ name: 'Dana Kim', team: 'GC/HX - Dispatch' });
      writeRememberedIdentity('Sam Lee', 'Info booth');
      expect(readPrefs()).toMatchObject({ rememberedName: 'Sam Lee', rememberedTeam: 'Info booth' });
      clearRememberedIdentity();
      expect(readPrefs()).toMatchObject({ rememberedName: null, rememberedTeam: null });
      // Invalid input forgets rather than storing half an identity.
      writeRememberedIdentity('Sam Lee', 'Medical');
      writeRememberedIdentity('S', 'Medical');
      expect(readPrefs().rememberedName).toBeNull();
    });

    it('ignores corrupt or tampered stored values', () => {
      browser.data.set(PREF_STORAGE_KEYS.identity, '{not json');
      // (Events) Any post label is kept (the form checks it against the open event's posts); a non-string is not.
      browser.data.set(PREF_STORAGE_KEYS.lastPost, JSON.stringify({ reportingLocation: 42, otherLocation: null }));
      browser.data.set(PREF_STORAGE_KEYS.bell, 'yes');
      browser.data.set(THEME_STORAGE_KEY, 'purple');
      expect(readPrefs()).toEqual(DEFAULT_PREFS);
      browser.data.set(PREF_STORAGE_KEYS.identity, JSON.stringify({ name: 'Dana Kim' }));
      expect(readPrefs().rememberedName).toBeNull();
    });

    it('remembers the last post (Other needs its location) and the bell flags', () => {
      setLastPost({ reportingLocation: 'FA 4 – Oasis', otherLocation: 'ignored' });
      expect(readPrefs().lastPost).toEqual({ reportingLocation: 'FA 4 – Oasis', otherLocation: null });
      setLastPost({ reportingLocation: 'Other', otherLocation: ' Info booth ' });
      expect(readPrefs().lastPost).toEqual({ reportingLocation: 'Other', otherLocation: 'Info booth' });
      setLastPost({ reportingLocation: 'Other', otherLocation: '' });
      expect(readPrefs().lastPost).toEqual({ reportingLocation: 'Other', otherLocation: 'Info booth' });
      setLastPost(null);
      expect(readPrefs().lastPost).toBeNull();

      setBell(true);
      setBellIntroSeen(true);
      expect(readPrefs()).toMatchObject({ bell: true, bellIntroSeen: true });
      setBell(false);
      expect(readPrefs().bell).toBe(false);
      expect(browser.data.has(PREF_STORAGE_KEYS.bell)).toBe(false);
    });

    it('F6 follow-up: the bell is an old bell until the server has taken it; a copy of the switch never is', () => {
      expect(readOldBell()).toBe(false);
      // Set on this phone by a build from before the server switch: sent as the default of New requests.
      setBell(true);
      setBellIntroSeen(true);
      expect(readOldBell()).toBe(true);
      // The server answered (it took that bell): from now on the bell only copies the signed-in staff member's switch.
      markBellFromServer();
      expect(browser.data.get(BELL_FROM_SERVER_KEY)).toBe('1');
      expect(readOldBell()).toBe(false);
      expect(readPrefs()).toMatchObject({ bell: true, bellIntroSeen: true });
      // Sign-out: the bell, its intro and where it came from all go.
      forgetBell();
      expect(readPrefs()).toMatchObject({ bell: false, bellIntroSeen: false });
      expect([PREF_STORAGE_KEYS.bell, PREF_STORAGE_KEYS.bellIntroSeen, BELL_FROM_SERVER_KEY].filter((k) => browser.data.has(k))).toEqual([]);
    });

    it('F6 follow-up: a sign-in by anyone but the remembered staff member (or after Change) forgets the bell', () => {
      const bellOn = () => {
        setBell(true);
        setBellIntroSeen(true);
        markBellFromServer();
      };
      writeRememberedIdentity('Rae Chen', 'Medical');
      bellOn();
      // The same staff member (any spacing or case, a team alias): theirs, kept.
      forgetBellForOtherStaff('  rae  chen ', 'medical');
      expect(readPrefs()).toMatchObject({ bell: true, bellIntroSeen: true });
      expect(browser.data.get(BELL_FROM_SERVER_KEY)).toBe('1');
      // Someone else on this phone: gone.
      forgetBellForOtherStaff('Kai Ode', 'Medical');
      expect(readPrefs()).toMatchObject({ bell: false, bellIntroSeen: false });
      expect(browser.data.has(BELL_FROM_SERVER_KEY)).toBe(false);
      // "Change" cleared the remembered identity: nobody to compare with, so it goes too.
      bellOn();
      clearRememberedIdentity();
      forgetBellForOtherStaff('Rae Chen', 'Medical');
      expect(readPrefs().bell).toBe(false);
    });

    it('theme: one source of truth shared with the pre-paint script, applied on write', () => {
      setThemePref('dark');
      expect(browser.data.get(THEME_STORAGE_KEY)).toBe('dark');
      expect(browser.classes.has('dark')).toBe(true);
      expect(readPrefs().theme).toBe('dark');
      setThemePref('auto');
      expect(browser.data.has(THEME_STORAGE_KEY)).toBe(false);
      expect(browser.classes.has('light')).toBe(true);
      expect(readPrefs().theme).toBe('auto');
    });

    it('writePref keeps the remembered name and team as a pair', () => {
      writePref('rememberedName', 'Dana Kim');
      expect(readPrefs().rememberedName).toBeNull(); // no team yet
      writeRememberedIdentity('Dana Kim', 'Medical');
      writePref('rememberedTeam', 'GC/HX - Base');
      expect(readPrefs()).toMatchObject({ rememberedName: 'Dana Kim', rememberedTeam: 'GC/HX - Base' });
      writePref('rememberedTeam', null);
      expect(readPrefs()).toMatchObject({ rememberedName: null, rememberedTeam: null });
    });

    it('the store starts from storage and setPref writes through (theme applied by the store, not the screen)', () => {
      writeRememberedIdentity('Dana Kim', 'Medical');
      setThemePref('dark');
      const store = createStubStore({ eventTimezone: 'America/New_York' });
      expect(store.getState().prefs).toMatchObject({ theme: 'dark', rememberedName: 'Dana Kim', rememberedTeam: 'Medical', bell: false });
      store.actions.setPref('theme', 'light');
      store.actions.setPref('bell', true);
      store.actions.setPref('bellIntroSeen', true);
      store.actions.setPref('lastPost', { reportingLocation: 'Base', otherLocation: null });
      expect(browser.data.get(THEME_STORAGE_KEY)).toBe('light');
      expect(browser.classes.has('light')).toBe(true);
      expect(readPrefs()).toEqual({ ...store.getState().prefs });
    });

    it('the All requests "Closed" fold is remembered for this browser session only', () => {
      expect(readPrefs().closedExpanded).toBe(false);
      setClosedExpanded(true);
      expect(browser.session.get(SESSION_PREF_KEYS.closedExpanded)).toBe('1');
      expect(browser.data.has(SESSION_PREF_KEYS.closedExpanded)).toBe(false); // never in localStorage
      expect(readPrefs().closedExpanded).toBe(true);
      writePref('closedExpanded', false);
      expect(browser.session.has(SESSION_PREF_KEYS.closedExpanded)).toBe(false);
      expect(readPrefs().closedExpanded).toBe(false);

      const store = createStubStore({ eventTimezone: 'America/New_York' });
      store.actions.setPref('closedExpanded', true);
      expect(store.getState().prefs.closedExpanded).toBe(true);
      expect(readPrefs()).toEqual({ ...store.getState().prefs });
    });

    it('the brand row over All requests: hidden with its X on this device (localStorage), until Show header', () => {
      expect(DEFAULT_PREFS.brandHidden).toBe(false);
      expect(readPrefs().brandHidden).toBe(false);
      setBrandHidden(true);
      expect(browser.data.get(PREF_STORAGE_KEYS.brandHidden)).toBe('1');
      expect(PREF_STORAGE_KEYS.brandHidden).toBe('lp-brand-hidden');
      expect(readPrefs().brandHidden).toBe(true);
      // The desk's server-drawn row reads <html data-brand-hidden> before paint (lib/brand-pref.ts).
      expect(browser.attributes.has('data-brand-hidden')).toBe(true);
      writePref('brandHidden', false);
      expect(browser.data.has(PREF_STORAGE_KEYS.brandHidden)).toBe(false);
      expect(readPrefs().brandHidden).toBe(false);
      expect(browser.attributes.has('data-brand-hidden')).toBe(false);
      // Anything but '1' reads as shown.
      browser.data.set(PREF_STORAGE_KEYS.brandHidden, 'yes');
      expect(readPrefs().brandHidden).toBe(false);
      browser.data.delete(PREF_STORAGE_KEYS.brandHidden);

      // Through the store: setPref writes through, and another tab's change arrives through the storage event.
      const store = createStubStore({ eventTimezone: 'America/New_York' });
      store.actions.setPref('brandHidden', true);
      expect(store.getState().prefs.brandHidden).toBe(true);
      expect(readPrefs()).toEqual({ ...store.getState().prefs });
      const seen: boolean[] = [];
      const off = subscribePrefs((p) => seen.push(p.brandHidden));
      expect(browser.attributes.has('data-brand-hidden')).toBe(true);
      browser.data.delete(PREF_STORAGE_KEYS.brandHidden);
      browser.fire(PREF_STORAGE_KEYS.brandHidden);
      off();
      expect(seen).toEqual([false]);
      // Shown again from another tab: the mark goes too, or the desk's row would stay display: none.
      expect(browser.attributes.has('data-brand-hidden')).toBe(false);
    });

    it('a browser without sessionStorage folds Closed and never throws', () => {
      vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
      expect(() => setClosedExpanded(true)).not.toThrow();
      expect(readPrefs().closedExpanded).toBe(false);
    });

    it('notifies about changes made in another tab', () => {
      const seen: boolean[] = [];
      const off = subscribePrefs((p) => seen.push(p.bell));
      browser.data.set(PREF_STORAGE_KEYS.bell, '1');
      browser.fire(PREF_STORAGE_KEYS.bell);
      browser.fire('unrelated-key');
      browser.fire(null); // localStorage.clear()
      off();
      browser.fire(PREF_STORAGE_KEYS.bell);
      expect(seen).toEqual([true, true]);
      expect(browser.listeners.size).toBe(0);
    });
  });
});
