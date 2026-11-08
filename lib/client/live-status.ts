// The connection state and the line under the view title (v2.2 afternoon, Brian 2026-11-06: the Apple Mail
// model). ONE derivation, liveState(), feeds the line, the banner, the avatar badge and the screen-reader live
// region, so they never disagree (the F1.1 review found the line saying Reconnecting under an Offline banner).
//
//   healthy       syncs land: green dot, "Updated just now" (last good sync under 60 s old), then
//                 "Updated 1 min ago", "Updated 5 min ago", "Updated 1 hr ago". Minutes only, never seconds.
//                 (2026-11-08, network fix 1d) "Updating…" with a turning arrow in the dot's place while the list
//                 shown is not this visit's yet: nothing synced this load, or the last sync landed before the page
//                 came back into view and is at least 15 s old. The age shows again once that sync lands.
//   reconnecting  the phone reports a connection, but syncs fail (the store's connection is 'error', or
//                 'offline' after failed requests), the view's own fetches fail by the same thresholds (the
//                 dashboard's stats: 2 network failures or 3 server errors in a row), or nothing has landed
//                 for more than 30 s of visible time: the amber "Reconnecting…" banner, and the line reads
//                 "Last updated 3:42 PM" with an amber dot. (On the dashboard the lists' syncs count as
//                 landing too, so one missed 15 s stats poll never reads as Reconnecting.)
//   offline       the phone reports no connection: the gray "Offline · N waiting to send" banner, and the
//                 line reads "Last updated 3:42 PM" with a gray dot.
//
// Everything here is a pure function of (sync time, connection, device online, visibility, now), so tests
// drive it with fake timers. The line re-renders only when its words change: a source wakes at the next
// minute boundary since the last sync (or when a healthy line would turn stale), never once a second.
import { formatCreatedTime } from '../format';
import type { Connection } from './store-contract';

export type LiveState = 'healthy' | 'reconnecting' | 'offline';

/** No successful sync for longer than this (while the page is visible) reads as Reconnecting. */
export const STALE_AFTER_MS = 30_000;
/** A sync that landed before the page came back into view and is at least this old reads "Updating…" (fix 1d). */
export const UPDATING_AFTER_MS = 15_000;
/** The line's granularity: "just now" under one minute, then whole minutes, then whole hours. */
export const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface LiveInput {
  /** This phone's clock (epoch ms) when the last successful sync landed; null before the first one. */
  syncedAt: number | null;
  connection: Connection;
  now: number;
  /** The phone reports a connection (navigator.onLine). Defaults to true. */
  online?: boolean;
  /** When the page last became visible (epoch ms); null: visible since it loaded. */
  visibleSince?: number | null;
  /** The page is hidden: staleness doesn't count (background tabs poll once a minute). */
  hidden?: boolean;
  /** The view's own fetches failed past the lists' thresholds (the dashboard's stats, useStats().failing). */
  failing?: boolean;
  /**
   * When anything else last landed (epoch ms; the dashboard: the lists' last sync). It counts for the 30 s rule
   * ("nothing landed"), never for the line's words.
   */
  aliveAt?: number | null;
}

/** When the 30 s rule counts from: the last thing that landed, or the page coming back into view; null: never. */
function staleFrom({ syncedAt, aliveAt = null, visibleSince = null }: LiveInput): number | null {
  const landed = syncedAt === null ? aliveAt : aliveAt === null ? syncedAt : Math.max(syncedAt, aliveAt);
  if (landed === null) return null;
  // Visible time only: a phone back from the lock screen gets 30 s for its catch-up sync.
  return visibleSince === null ? landed : Math.max(landed, visibleSince);
}

/** The one state every connection cue shows. */
export function liveState(input: LiveInput): LiveState {
  const { connection, now, online = true, hidden = false, failing = false } = input;
  if (!online) return 'offline';
  if (connection !== 'live' || failing) return 'reconnecting';
  const since = hidden ? null : staleFrom(input);
  if (since !== null && now - since > STALE_AFTER_MS) return 'reconnecting';
  return 'healthy';
}

/**
 * (network fix 1d, 2026-11-08) The line reads "Updating…": healthy (an offline or reconnecting phone keeps its banner
 * and clock time), visible, and either nothing has synced this load, or the last sync landed before the page came
 * back into view and is at least UPDATING_AFTER_MS old (its resume sync is on its way). A glance back within 15 s
 * never flickers; 30 s of visible time with nothing landed reads Reconnecting, as before.
 */
export function isUpdating(input: LiveInput): boolean {
  const { syncedAt, now, visibleSince = null, hidden = false } = input;
  if (hidden || liveState(input) !== 'healthy') return false;
  if (syncedAt === null) return true;
  return visibleSince !== null && syncedAt < visibleSince && now - syncedAt >= UPDATING_AFTER_MS;
}

/** "just now" under a minute (a sync that lands between two renders, a negative age, too), "5 min ago", "1 hr ago". */
export function updatedAgo(ageMs: number): string {
  if (ageMs < MINUTE_MS) return 'just now';
  if (ageMs < HOUR_MS) return `${Math.floor(ageMs / MINUTE_MS)} min ago`;
  return `${Math.floor(ageMs / HOUR_MS)} hr ago`;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

/** updatedAgo as a screen reader says it: "just now", "1 minute ago", "5 minutes ago", "1 hour ago". */
export function updatedAgoSpoken(ageMs: number): string {
  if (ageMs < MINUTE_MS) return 'just now';
  if (ageMs < HOUR_MS) return plural(Math.floor(ageMs / MINUTE_MS), 'minute');
  return plural(Math.floor(ageMs / HOUR_MS), 'hour');
}

export interface LiveLine {
  state: LiveState;
  /** The visible words: "Updated just now", "Last updated 3:42 PM", "Updating…"; null before the first sync while a banner shows. */
  text: string | null;
  /** The same as one sentence for screen readers: "Reconnecting. List last updated at 3:42 PM.", "Updating the list." */
  sentence: string | null;
  /** "Updating…" (isUpdating): the line shows a turning arrow in the dot's place. */
  updating?: boolean;
}

export interface LiveWords {
  /** Starts the spoken sentence: "List updated just now.", "Dashboard updated 1 minute ago." */
  subject?: string;
  /** IANA zone of the clock time ("Last updated 3:42 PM"). */
  timeZone: string;
}

const LEAD: Readonly<Record<Exclude<LiveState, 'healthy'>, string>> = { reconnecting: 'Reconnecting', offline: 'Offline' };

/**
 * What the line shows. Healthy: the age in minutes. While a banner shows (Reconnecting, Offline): the fixed clock
 * time of the last good sync, in the event timezone ("3:42 PM"; "Thu 11:02 PM" for an earlier event day).
 */
export function liveLine(input: LiveInput, { subject = 'List', timeZone }: LiveWords): LiveLine {
  const state = liveState(input);
  const { syncedAt, now } = input;
  if (isUpdating(input)) return { state, text: 'Updating…', sentence: `Updating the ${subject.toLowerCase()}.`, updating: true };
  if (syncedAt === null) return { state, text: null, sentence: null };
  if (state === 'healthy') {
    const age = now - syncedAt;
    return { state, text: `Updated ${updatedAgo(age)}`, sentence: `${subject} updated ${updatedAgoSpoken(age)}.` };
  }
  const clock = formatCreatedTime(syncedAt, now, timeZone);
  return { state, text: `Last updated ${clock}`, sentence: `${LEAD[state]}. ${subject} last updated at ${clock}.` };
}

export const sameLine = (a: LiveLine, b: LiveLine) => a === b || (a.state === b.state && a.text === b.text && a.sentence === b.sentence);

/**
 * When the line's words can next change with no new event (epoch ms), or null when only an event (a sync, the
 * connection, online / offline, visibility) can change them. Healthy: the next minute boundary since the last
 * sync, the moment it turns stale, or (back in view with a sync not yet 15 s old) the moment it reads Updating…,
 * whichever comes first. Updating… waits for its sync or the stale moment. A banner state shows a fixed clock
 * time: nothing.
 */
export function nextLiveChange(input: LiveInput): number | null {
  const { syncedAt, now, hidden = false, visibleSince = null } = input;
  if (hidden || liveState(input) !== 'healthy') return null;
  const since = staleFrom(input);
  const stale = since === null ? Infinity : since + STALE_AFTER_MS + 1;
  if (syncedAt === null) return since === null ? null : stale;
  if (isUpdating(input)) return stale;
  const age = now - syncedAt;
  const nextMinute = syncedAt + (age < 0 ? MINUTE_MS : (Math.floor(age / MINUTE_MS) + 1) * MINUTE_MS);
  const updatingAt = visibleSince !== null && syncedAt < visibleSince ? syncedAt + UPDATING_AFTER_MS : Infinity;
  return Math.min(nextMinute, stale, updatingAt);
}

export interface StateCue {
  /** The colour of the line's dot, the banner and the avatar badge. */
  tone: 'green' | 'amber' | 'gray';
  /** The banner's words, or null: no banner. */
  banner: string | null;
  /** The avatar badge's name, or null: no badge. */
  badge: string | null;
}

/** Everything besides the line that shows a state, from the one table (the banner, the avatar badge). */
export function stateCue(state: LiveState, waiting = 0): StateCue {
  switch (state) {
    case 'healthy':
      return { tone: 'green', banner: null, badge: null };
    case 'reconnecting':
      return { tone: 'amber', banner: 'Reconnecting…', badge: 'Reconnecting' };
    case 'offline':
      return { tone: 'gray', banner: `Offline · ${waiting} waiting to send`, badge: 'Offline' };
  }
}

/** The live region's words for a change of state, or null when the state is unchanged. Never the minutes. */
export function liveAnnouncement(from: LiveState, to: LiveState): string | null {
  if (from === to) return null;
  return to === 'healthy' ? 'Back online' : LEAD[to];
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

// ---------------------------------------------------------------------------------------------------
// Page visibility: whether the page is hidden, and when it last became visible (one document listener)
// ---------------------------------------------------------------------------------------------------

export interface PageVisibility {
  hidden: boolean;
  /** When the page last became visible (null: visible since it loaded). */
  since: number | null;
}

const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
let visibility: PageVisibility = { hidden: false, since: null };
const visibilityListeners = new Set<() => void>();
let watchingVisibility = false;

/** Remembers when the page comes back into view, even while no line is mounted (one listener, kept). */
function watchVisibility() {
  if (watchingVisibility || typeof document === 'undefined') return;
  watchingVisibility = true;
  visibility = { hidden: pageHidden(), since: null };
  document.addEventListener('visibilitychange', () => {
    visibility = pageHidden() ? { ...visibility, hidden: true } : { hidden: false, since: Date.now() };
    for (const listener of [...visibilityListeners]) listener();
  });
}

export function readVisibility(): PageVisibility {
  watchVisibility();
  return visibility;
}

export function subscribeVisibility(listener: () => void): () => void {
  watchVisibility();
  visibilityListeners.add(listener);
  return () => {
    visibilityListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------------------------------
// A live source: the line for one view, as a useSyncExternalStore store
// ---------------------------------------------------------------------------------------------------

export interface LiveData {
  syncedAt: number | null;
  connection: Connection;
  failing?: boolean;
  aliveAt?: number | null;
}

/** The page around the line: is the phone online, is the page visible (tests pass their own). */
export interface LivePage {
  online(): boolean;
  visibility(): PageVisibility;
  /** Calls back on online / offline and on visibility changes. */
  subscribe(onChange: () => void): () => void;
}

export const browserPage: LivePage = {
  online: readDeviceOnline,
  visibility: readVisibility,
  subscribe(onChange) {
    const offOnline = subscribeDeviceOnline(onChange);
    const offVisibility = subscribeVisibility(onChange);
    return () => {
      offOnline();
      offVisibility();
    };
  },
};

export interface LiveSourceOptions extends LiveWords {
  /** The view's data: the store's last sync and connection (or the dashboard's last stats fetch). */
  read: () => LiveData;
  /** Calls back on every change of that data (the store's subscribe). */
  subscribe: (onChange: () => void) => () => void;
  /** The same data as the server rendered it (hydration); defaults to `read`. */
  readServer?: () => LiveData;
  page?: LivePage;
}

export interface LiveSource {
  subscribe(listener: () => void): () => void;
  /** The line now: the very same object while its words are unchanged, so React skips the render. */
  getSnapshot(): LiveLine;
  getServerSnapshot(): LiveLine;
}

/**
 * The line for one view. Its clock (`now`) moves only on an event (the data changed, online / offline,
 * visibility) or on its own single timer, set for nextLiveChange(): while syncs land every 6 s that moment
 * keeps moving away and the timer never fires, so a healthy line renders at most once a minute.
 */
export function createLiveSource({
  read,
  subscribe: subscribeData,
  readServer = read,
  subject,
  timeZone,
  page = browserPage,
}: LiveSourceOptions): LiveSource {
  let now = Date.now();
  let last: LiveLine | null = null;
  let lastServer: LiveLine | null = null;
  const words = { subject, timeZone };

  const input = (): LiveInput => {
    const data = read();
    const { hidden, since } = page.visibility();
    return { ...data, online: page.online(), now, visibleSince: since, hidden };
  };

  return {
    subscribe(listener) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        const at = nextLiveChange(input());
        if (at !== null) timer = setTimeout(wake, Math.max(0, at - Date.now()));
      };
      // Every event (and the timer itself) re-arms the one timer: arm() clears the pending one first.
      function wake() {
        now = Date.now();
        arm();
        listener();
      }
      const offs = [subscribeData(wake), page.subscribe(wake)];
      now = Date.now();
      arm();
      return () => {
        for (const off of offs) off();
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      };
    },
    getSnapshot() {
      const next = liveLine(input(), words);
      if (!last || !sameLine(last, next)) last = next;
      return last;
    },
    getServerSnapshot() {
      const next = liveLine({ ...readServer(), now, online: true }, words);
      if (!lastServer || !sameLine(lastServer, next)) lastServer = next;
      return lastServer;
    },
  };
}
