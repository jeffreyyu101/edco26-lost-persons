// The live indicator under the view title (design/screens/live-indicator.html, approved by Brian 2026-11-06):
// a plain dot and "Updated now" / "Updated 6s ago" / "Updated 2m ago", counted from the last successful sync.
//   live          green dot while syncs land
//   reconnecting  amber dot and "Reconnecting · updated 2m ago": no sync has landed for 30 s of visible time,
//                 or the phone is online but can't reach the log (the store's connection is 'error', or
//                 'offline' after failed requests while the phone itself reports a connection)
//   offline       grey dot and "Offline · updated 5m ago": the phone reports no connection
// Before the first sync there is nothing to show (null).
//
// The state and the words are pure functions of (sync time, connection, device online, now), so tests drive
// them with fake timers. `secondClock` is the one clock: it ticks once a second only while an indicator is on
// screen and the page is visible, and it remembers when the page last became visible, so a phone back from the
// lock screen is not "Reconnecting" for the moment its catch-up sync takes.
import type { Connection } from './store-contract';

export type LiveState = 'live' | 'reconnecting' | 'offline';

/** No successful sync for longer than this (while the page is visible) reads as Reconnecting. */
export const STALE_AFTER_MS = 30_000;
/** Under this age the line reads "Updated now". */
export const JUST_NOW_MS = 2_000;
/** The indicator's clock tick. */
export const LIVE_TICK_MS = 1_000;

export interface LiveInput {
  /** This phone's clock (epoch ms) when the last successful sync landed; null before the first one. */
  syncedAt: number | null;
  connection: Connection;
  now: number;
  /** The phone reports a connection (navigator.onLine). Defaults to true. */
  online?: boolean;
  /** When the page last became visible (epoch ms). Staleness only counts visible time. */
  visibleSince?: number | null;
  /** The view's own fetch is failing (the dashboard's stats): Reconnecting. */
  failing?: boolean;
}

export function liveState({ syncedAt, connection, now, online = true, visibleSince = null, failing = false }: LiveInput): LiveState | null {
  if (syncedAt === null) return null;
  if (!online) return 'offline';
  if (connection !== 'live' || failing) return 'reconnecting';
  const since = visibleSince === null ? syncedAt : Math.max(syncedAt, visibleSince);
  return now - since > STALE_AFTER_MS ? 'reconnecting' : 'live';
}

/** "now", "6s ago", "2m ago", "3h ago". A sync that lands between two ticks (a negative age) is "now". */
export function agoShort(ageMs: number): string {
  if (ageMs < JUST_NOW_MS) return 'now';
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

/** agoShort as a screen reader says it: "just now", "6 seconds ago", "1 minute ago", "3 hours ago". */
export function agoLong(ageMs: number): string {
  if (ageMs < JUST_NOW_MS) return 'just now';
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 60) return plural(seconds, 'second');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  return plural(Math.floor(minutes / 60), 'hour');
}

export interface LiveLine {
  state: LiveState;
  /** "Reconnecting" / "Offline" before the time, or null while live. */
  lead: string | null;
  /** The rest of the visible line: "Updated 6s ago", or " · updated 2m ago" after a lead. */
  text: string;
  /** The whole line as one sentence for screen readers: "Reconnecting. List updated 2 minutes ago". */
  sentence: string;
}

const LEAD: Readonly<Record<LiveState, string | null>> = { live: null, reconnecting: 'Reconnecting', offline: 'Offline' };

/** What the indicator shows, or null before the first sync. `subject` starts the spoken sentence. */
export function liveLine(input: LiveInput, subject = 'List'): LiveLine | null {
  const state = liveState(input);
  if (state === null || input.syncedAt === null) return null;
  const age = input.now - input.syncedAt;
  const lead = LEAD[state];
  const said = `${subject} updated ${agoLong(age)}`;
  return {
    state,
    lead,
    text: lead ? ` · updated ${agoShort(age)}` : `Updated ${agoShort(age)}`,
    sentence: lead ? `${lead}. ${said}` : said,
  };
}

/** The live region's words for a state change ("List is live", "Reconnecting", "Offline"); never the ticks. */
export function liveAnnouncement(state: LiveState, subject = 'List'): string {
  return state === 'live' ? `${subject} is live` : (LEAD[state] as string);
}

// ---------------------------------------------------------------------------------------------------
// The indicator's clock: one interval for every indicator on screen, stopped while the page is hidden
// ---------------------------------------------------------------------------------------------------

export interface SecondClock {
  now: number;
  /** When the page last became visible (null: visible since it loaded). */
  visibleSince: number | null;
}

let clock: SecondClock = { now: Date.now(), visibleSince: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let watchingVisibility = false;

const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function notify() {
  for (const listener of [...listeners]) listener();
}

function startTimer() {
  if (timer || listeners.size === 0 || pageHidden()) return;
  timer = setInterval(() => {
    clock = { ...clock, now: Date.now() };
    notify();
  }, LIVE_TICK_MS);
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Remembers when the page comes back into view, even while no indicator is mounted (one listener, kept). */
function watchVisibility() {
  if (watchingVisibility || typeof document === 'undefined') return;
  watchingVisibility = true;
  document.addEventListener('visibilitychange', () => {
    if (pageHidden()) {
      stopTimer();
      return;
    }
    const now = Date.now();
    clock = { now, visibleSince: now };
    notify();
    startTimer();
  });
}

/** Subscribe to the once-a-second clock (useSyncExternalStore). Returns the unsubscribe function. */
export function subscribeSecondClock(listener: () => void): () => void {
  watchVisibility();
  listeners.add(listener);
  startTimer();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopTimer();
  };
}

/**
 * The clock's last tick (the same object until the next one). With nothing subscribed it is brought up to
 * date at most once a second, so a freshly mounted indicator never starts from an old time.
 */
export function readSecondClock(): SecondClock {
  if (listeners.size === 0) {
    const now = Date.now();
    if (Math.abs(now - clock.now) >= LIVE_TICK_MS) clock = { ...clock, now };
  }
  return clock;
}

// ---------------------------------------------------------------------------------------------------
// Whether the phone reports a connection (navigator.onLine and its online / offline events)
// ---------------------------------------------------------------------------------------------------

/** navigator.onLine, true where unknown (the server, tests). */
export function readDeviceOnline(): boolean {
  return typeof navigator === 'undefined' || (navigator as { onLine?: boolean }).onLine !== false;
}

export function subscribeDeviceOnline(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}
