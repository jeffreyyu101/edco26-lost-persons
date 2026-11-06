// Remembered on this phone (spec §7 "Remembered on this phone"): the ONE place that reads and writes
// the theme, the bell, the "Alerts are on" intro flag, the remembered name and team, and the last post.
// No React and no store import: plain localStorage, so it also works on /signin, which renders outside
// StoreProvider. It is safe on the server (reads return DEFAULT_PREFS) and in private mode, where writes
// are best-effort and never throw.
//
// Who uses it:
//   * The store (lib/client/store.tsx). `state.prefs` starts as readPrefs(). `setPref(key, value)` calls
//     writePref(key, value), then updates the state. So setPref('theme', t) also applies the theme
//     (applyTheme in lib/theme.ts). Screens inside the app call only setPref and never applyTheme.
//   * SignInFlow (/signin). readPrefs() gives the remembered name and team (skip to step 2, and the step-2
//     prefill after a 401). It calls writeRememberedIdentity() after a successful sign-in, with the
//     POST /api/session response's staffName and team, and clearRememberedIdentity() on "Change". The
//     theme toggle calls setThemePref().
//   * Phone-created request ids are NOT stored here. They live in IndexedDB next to the store's cache
//     (spec §4 "Staff identity and ownership") and are cleared on sign-out. Prefs survive sign-out.
//   * One pref lasts for the browser session only: `closedExpanded` (the All requests "Closed" fold, log
//     option B, 2026-11-06) lives in sessionStorage.
//   * `brandHidden` (v2.2, 2026-11-06 afternoon): the brand row over All requests was hidden with its X on
//     this device; the avatar menu's "Show header" brings it back.
//
// FROZEN after Phase 1a: later phases may ADD exports, never change existing ones.
import {
  OTHER_LOCATION_MAX,
  OTHER_POST,
  OTHER_TEAM_MAX,
  STAFF_NAME_MAX,
  STAFF_NAME_MIN,
  canonicalTeam,
  isPostValue,
  type PostValue,
} from '../domain';
import { THEME_STORAGE_KEY, applyTheme, readThemeChoice, type ThemeChoice } from '../theme';

export type ThemePref = ThemeChoice;

export interface LastPost {
  reportingLocation: PostValue;
  /** Required (1–80 characters) when reportingLocation is 'Other', else null. */
  otherLocation: string | null;
}

/** Remembered on this phone (spec §7). The app always opens on All. */
export interface Prefs {
  theme: ThemePref;
  /** New-request alerts (off by default). */
  bell: boolean;
  /** The "Alerts are on" sheet has been shown (it shows only the first time the bell is turned on). */
  bellIntroSeen: boolean;
  /** The last signed-in name. Always set together with rememberedTeam: both, or neither. */
  rememberedName: string | null;
  /** Canonical team value (or the custom Other text) of the last sign-in. */
  rememberedTeam: string | null;
  /** No default until one is chosen once. */
  lastPost: LastPost | null;
  /**
   * All requests: the "Closed N" fold is open. Remembered for this browser session only (sessionStorage),
   * so a new session starts folded.
   */
  closedExpanded: boolean;
  /** The brand row over All requests was hidden with its X (on this device, until "Show header"). */
  brandHidden: boolean;
}

export const DEFAULT_PREFS: Readonly<Prefs> = Object.freeze({
  theme: 'auto',
  bell: false,
  bellIntroSeen: false,
  rememberedName: null,
  rememberedTeam: null,
  lastPost: null,
  closedExpanded: false,
  brandHidden: false,
});

/** sessionStorage keys: prefs that last for this browser session only. */
export const SESSION_PREF_KEYS = {
  /** '1' while the All requests "Closed" fold is open; absent when folded */
  closedExpanded: 'lp-closed-expanded',
} as const;

/** localStorage keys. The theme key is shared with the pre-paint THEME_SCRIPT (lib/theme.ts). */
export const PREF_STORAGE_KEYS = {
  theme: THEME_STORAGE_KEY,
  /** JSON {name, team} */
  identity: 'lp-identity',
  /** JSON {reportingLocation, otherLocation} */
  lastPost: 'lp-last-post',
  /** '1' when on; absent when off */
  bell: 'lp-bell',
  /** '1' once the "Alerts are on" sheet has been shown */
  bellIntroSeen: 'lp-bell-intro-seen',
  /** '1' while the brand row over All requests is hidden; absent when shown */
  brandHidden: 'lp-brand-hidden',
} as const;

const ALL_KEYS: ReadonlySet<string> = new Set(Object.values(PREF_STORAGE_KEYS));

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    const s = storage();
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // Private mode / quota: the pref simply isn't remembered.
  }
}

function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : (window.sessionStorage ?? null);
  } catch {
    return null;
  }
}

function readSession(key: string): string | null {
  try {
    return sessionStore()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string | null): void {
  try {
    const s = sessionStore();
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // Private mode / quota: the fold simply starts closed next time.
  }
}

function readJson(key: string): unknown {
  const raw = read(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

const codePoints = (s: string) => Array.from(s).length;

function cleanIdentity(name: unknown, team: unknown): { name: string; team: string } | null {
  if (typeof name !== 'string' || typeof team !== 'string') return null;
  const n = name.trim().replace(/\s+/g, ' ');
  const t = canonicalTeam(team);
  if (codePoints(n) < STAFF_NAME_MIN || codePoints(n) > STAFF_NAME_MAX) return null;
  if (codePoints(t) < 2 || codePoints(t) > OTHER_TEAM_MAX) return null;
  return { name: n, team: t };
}

function cleanLastPost(value: unknown): LastPost | null {
  if (!value || typeof value !== 'object') return null;
  const { reportingLocation, otherLocation } = value as Record<string, unknown>;
  if (!isPostValue(reportingLocation)) return null;
  if (reportingLocation !== OTHER_POST) return { reportingLocation, otherLocation: null };
  if (typeof otherLocation !== 'string') return null;
  const where = otherLocation.trim();
  if (!where || codePoints(where) > OTHER_LOCATION_MAX) return null;
  return { reportingLocation, otherLocation: where };
}

/** Everything remembered on this phone. Invalid or missing values read as the defaults. */
export function readPrefs(): Prefs {
  if (!storage()) return { ...DEFAULT_PREFS };
  const raw = readJson(PREF_STORAGE_KEYS.identity) as { name?: unknown; team?: unknown } | null;
  const identity = raw && typeof raw === 'object' ? cleanIdentity(raw.name, raw.team) : null;
  return {
    theme: readThemeChoice(),
    bell: read(PREF_STORAGE_KEYS.bell) === '1',
    bellIntroSeen: read(PREF_STORAGE_KEYS.bellIntroSeen) === '1',
    rememberedName: identity?.name ?? null,
    rememberedTeam: identity?.team ?? null,
    lastPost: cleanLastPost(readJson(PREF_STORAGE_KEYS.lastPost)),
    closedExpanded: readSession(SESSION_PREF_KEYS.closedExpanded) === '1',
    brandHidden: read(PREF_STORAGE_KEYS.brandHidden) === '1',
  };
}

/** All requests: remember (for this browser session) whether the "Closed" fold is open. */
export function setClosedExpanded(open: boolean): void {
  writeSession(SESSION_PREF_KEYS.closedExpanded, open ? '1' : null);
}

/** After a successful sign-in: remember the name and (canonical) team. Invalid input clears them. */
export function writeRememberedIdentity(name: string, team: string): void {
  const identity = cleanIdentity(name, team);
  write(PREF_STORAGE_KEYS.identity, identity ? JSON.stringify(identity) : null);
}

/** Sign-in "Change": forget the remembered name and team. Sign-out does NOT call this. */
export function clearRememberedIdentity(): void {
  write(PREF_STORAGE_KEYS.identity, null);
}

/** Remember the post chosen in the form (null forgets it). An invalid post is ignored. */
export function setLastPost(post: LastPost | null): void {
  if (post === null) {
    write(PREF_STORAGE_KEYS.lastPost, null);
    return;
  }
  const clean = cleanLastPost(post);
  if (clean) write(PREF_STORAGE_KEYS.lastPost, JSON.stringify(clean));
}

export function setBell(on: boolean): void {
  write(PREF_STORAGE_KEYS.bell, on ? '1' : null);
}

export function setBellIntroSeen(seen: boolean): void {
  write(PREF_STORAGE_KEYS.bellIntroSeen, seen ? '1' : null);
}

/** Hide (true) or show again (false) the brand row over All requests on this device. */
export function setBrandHidden(hidden: boolean): void {
  write(PREF_STORAGE_KEYS.brandHidden, hidden ? '1' : null);
}

/** Store the theme choice and apply it now (the same thing the pre-paint script reads). */
export function setThemePref(theme: ThemePref): void {
  if (typeof window === 'undefined') return;
  applyTheme(theme);
}

/**
 * Write one pref, as the store's setPref does. rememberedName / rememberedTeam are kept as a pair: setting
 * one keeps the other, and setting either to null (or leaving the pair incomplete) forgets both.
 */
export function writePref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  switch (key) {
    case 'theme':
      setThemePref(value as ThemePref);
      return;
    case 'bell':
      setBell(value as boolean);
      return;
    case 'bellIntroSeen':
      setBellIntroSeen(value as boolean);
      return;
    case 'lastPost':
      setLastPost(value as LastPost | null);
      return;
    case 'closedExpanded':
      setClosedExpanded(value as boolean);
      return;
    case 'brandHidden':
      setBrandHidden(value as boolean);
      return;
    case 'rememberedName':
    case 'rememberedTeam': {
      const current = readPrefs();
      const name = key === 'rememberedName' ? (value as string | null) : current.rememberedName;
      const team = key === 'rememberedTeam' ? (value as string | null) : current.rememberedTeam;
      if (name === null || team === null) clearRememberedIdentity();
      else writeRememberedIdentity(name, team);
      return;
    }
  }
}

/**
 * Calls `listener` with fresh prefs when another tab or window of this browser changes one (the `storage`
 * event never fires in the tab that wrote). Returns the unsubscribe function.
 */
export function subscribePrefs(listener: (prefs: Prefs) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || ALL_KEYS.has(event.key)) listener(readPrefs());
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
