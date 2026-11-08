// The connection state and the line under the title (lib/client/live-status.ts; v2.2 afternoon, the Apple Mail
// model): minute granularity ("Updated just now", "1 min ago", "1 hr ago"), a fixed clock time while a banner
// shows, ONE state derivation for the line, the banner, the avatar badge and the live region, a source that
// re-renders at most once a minute while healthy, and the Refresh now watcher. Fake timers; no DOM, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spinStopDelay, SPIN_MS } from '@/components/ui/LiveIndicator';
import {
  MINUTE_MS,
  STALE_AFTER_MS,
  UPDATING_AFTER_MS,
  createLiveSource,
  liveAnnouncement,
  liveLine,
  liveState,
  nextLiveChange,
  readDeviceOnline,
  stateCue,
  updatedAgo,
  updatedAgoSpoken,
  type LiveData,
  type LiveInput,
  type LiveLine,
  type LivePage,
  type LiveState,
  type PageVisibility,
} from '@/lib/client/live-status';
import { REFRESH_MAX_MS, REFRESH_START_GRACE_MS, watchRefresh } from '@/lib/client/refresh-now';
import type { Connection } from '@/lib/client/store-contract';
import { formatClockAmPm } from '@/lib/format';

// 3:42 PM in New York (EST, UTC-5) on Nov 6, 2026.
const T0 = Date.parse('2026-11-06T20:42:00Z');
const TZ = 'America/New_York';
const s = (n: number) => n * 1_000;
const min = (n: number) => n * MINUTE_MS;
const words = { timeZone: TZ };

describe('updatedAgo / updatedAgoSpoken: minutes only, never seconds', () => {
  it('under a minute is "just now" (a sync that lands between two renders, a negative age, too)', () => {
    for (const age of [-1_500, 0, 1, s(6), s(30), s(59), MINUTE_MS - 1]) {
      expect(updatedAgo(age), String(age)).toBe('just now');
      expect(updatedAgoSpoken(age), String(age)).toBe('just now');
    }
  });

  it('59 s → just now, 60 s → 1 min, 59 min → 59 min, 60 min → 1 hr', () => {
    expect(updatedAgo(s(59))).toBe('just now');
    expect(updatedAgo(s(60))).toBe('1 min ago');
    expect(updatedAgo(min(2) - 1)).toBe('1 min ago');
    expect(updatedAgo(min(5))).toBe('5 min ago');
    expect(updatedAgo(min(59))).toBe('59 min ago');
    expect(updatedAgo(min(60) - 1)).toBe('59 min ago');
    expect(updatedAgo(min(60))).toBe('1 hr ago');
    expect(updatedAgo(min(119))).toBe('1 hr ago');
    expect(updatedAgo(min(120))).toBe('2 hr ago');
  });

  it('spoken in full words, singular and plural', () => {
    expect(updatedAgoSpoken(s(60))).toBe('1 minute ago');
    expect(updatedAgoSpoken(min(5))).toBe('5 minutes ago');
    expect(updatedAgoSpoken(min(59))).toBe('59 minutes ago');
    expect(updatedAgoSpoken(min(60))).toBe('1 hour ago');
    expect(updatedAgoSpoken(min(180))).toBe('3 hours ago');
  });
});

// ---------------------------------------------------------------------------------------------------
// One state for everything
// ---------------------------------------------------------------------------------------------------

interface Row {
  name: string;
  input: Omit<LiveInput, 'now'> & { at: number };
  state: LiveState;
}

/** The derivation table: every cue (the line, the banner, the badge, the live region) reads this one state. */
const TABLE: Row[] = [
  { name: 'syncs landing', input: { syncedAt: T0, connection: 'live', at: T0 + s(6) }, state: 'healthy' },
  { name: 'last sync exactly 30 s ago', input: { syncedAt: T0, connection: 'live', at: T0 + STALE_AFTER_MS }, state: 'healthy' },
  { name: 'nothing landed for > 30 s of visible time', input: { syncedAt: T0, connection: 'live', at: T0 + STALE_AFTER_MS + 1 }, state: 'reconnecting' },
  { name: '3 × 5xx (store: error)', input: { syncedAt: T0, connection: 'error', at: T0 + s(1) }, state: 'reconnecting' },
  {
    name: 'requests fail while the phone reports a connection (store: offline)',
    input: { syncedAt: T0, connection: 'offline', online: true, at: T0 + s(1) },
    state: 'reconnecting',
  },
  {
    name: "the view's own fetches failed past the lists' thresholds (dashboard stats: useStats().failing)",
    input: { syncedAt: T0, connection: 'live', failing: true, at: T0 + s(1) },
    state: 'reconnecting',
  },
  // The dashboard: its line counts from the last stats fetch (every 15 s), the 30 s rule from anything that landed.
  {
    name: 'dashboard: one stats poll missed (stats 42 s old), the lists synced 5 s ago',
    input: { syncedAt: T0, aliveAt: T0 + s(37), connection: 'live', at: T0 + s(42) },
    state: 'healthy',
  },
  {
    name: 'dashboard: nothing at all landed for > 30 s (stats nor lists)',
    input: { syncedAt: T0, aliveAt: T0 + s(10), connection: 'live', at: T0 + s(40) + 1 },
    state: 'reconnecting',
  },
  {
    name: 'dashboard: the lists synced long ago, the stats just now',
    input: { syncedAt: T0 + s(55), aliveAt: T0, connection: 'live', at: T0 + s(60) },
    state: 'healthy',
  },
  {
    name: 'dashboard: before the first stats, the lists stopped landing > 30 s ago',
    input: { syncedAt: null, aliveAt: T0, connection: 'live', at: T0 + STALE_AFTER_MS + 1 },
    state: 'reconnecting',
  },
  { name: 'the phone reports no connection', input: { syncedAt: T0, connection: 'offline', online: false, at: T0 + s(1) }, state: 'offline' },
  { name: 'no connection wins over failures and staleness', input: { syncedAt: T0, connection: 'error', online: false, at: T0 + min(5) }, state: 'offline' },
  { name: 'no connection before the first sync', input: { syncedAt: null, connection: 'offline', online: false, at: T0 }, state: 'offline' },
  { name: 'before the first sync, nothing wrong', input: { syncedAt: null, connection: 'live', at: T0 + min(5) }, state: 'healthy' },
  { name: 'failing before the first sync', input: { syncedAt: null, connection: 'error', at: T0 }, state: 'reconnecting' },
  {
    name: 'back from the lock screen: 30 s for the catch-up sync',
    input: { syncedAt: T0, connection: 'live', visibleSince: T0 + min(10), at: T0 + min(10) + s(30) },
    state: 'healthy',
  },
  {
    name: 'back from the lock screen, still nothing after 30 s',
    input: { syncedAt: T0, connection: 'live', visibleSince: T0 + min(10), at: T0 + min(10) + s(30) + 1 },
    state: 'reconnecting',
  },
  { name: 'hidden: staleness does not count', input: { syncedAt: T0, connection: 'live', hidden: true, at: T0 + min(5) }, state: 'healthy' },
];

const asInput = ({ at, ...rest }: Row['input']): LiveInput => ({ ...rest, now: at });

describe('the state derivation table (shared by the line, the banner and the badge)', () => {
  it.each(TABLE)('$name → $state', ({ input, state }) => {
    const i = asInput(input);
    expect(liveState(i)).toBe(state);
    // The line carries the same state…
    expect(liveLine(i, words).state).toBe(state);
    // …and so do the banner and the badge (one table of cues).
    const cue = stateCue(state, 2);
    if (state === 'healthy') expect(cue).toEqual({ tone: 'green', banner: null, badge: null });
    if (state === 'reconnecting') expect(cue).toEqual({ tone: 'amber', banner: 'Reconnecting…', badge: 'Reconnecting' });
    if (state === 'offline') expect(cue).toEqual({ tone: 'gray', banner: 'Offline · 2 waiting to send', badge: 'Offline' });
  });

  it('the live region announces state changes only: Reconnecting, Offline, Back online', () => {
    expect(liveAnnouncement('healthy', 'reconnecting')).toBe('Reconnecting');
    expect(liveAnnouncement('healthy', 'offline')).toBe('Offline');
    expect(liveAnnouncement('reconnecting', 'offline')).toBe('Offline');
    expect(liveAnnouncement('offline', 'reconnecting')).toBe('Reconnecting');
    expect(liveAnnouncement('reconnecting', 'healthy')).toBe('Back online');
    expect(liveAnnouncement('offline', 'healthy')).toBe('Back online');
    for (const state of ['healthy', 'reconnecting', 'offline'] as const) expect(liveAnnouncement(state, state)).toBeNull();
  });

  it('reads the phone as online where navigator.onLine is unknown', () => {
    expect(readDeviceOnline()).toBe(true);
  });
});

describe('liveLine: what the line shows and says', () => {
  it('healthy: "Updated just now" / "Updated 1 min ago", and one sentence for screen readers', () => {
    expect(liveLine({ syncedAt: T0, connection: 'live', now: T0 }, words)).toEqual({
      state: 'healthy',
      text: 'Updated just now',
      sentence: 'List updated just now.',
    });
    // The dashboard: its stats a minute old while the lists' syncs land, the age in minutes.
    expect(liveLine({ syncedAt: T0, aliveAt: T0 + s(65), connection: 'live', now: T0 + s(70) }, { ...words, subject: 'Dashboard' })).toEqual({
      state: 'healthy',
      text: 'Updated 1 min ago',
      sentence: 'Dashboard updated 1 minute ago.',
    });
    // (fix 1d) Back from the lock screen with a 5-minute-old sync: healthy for 30 s while the catch-up sync runs, and
    // the line says it is updating instead of showing the old age.
    expect(liveLine({ syncedAt: T0, connection: 'live', now: T0 + min(5) + s(10), visibleSince: T0 + min(5) }, { ...words, subject: 'Dashboard' })).toEqual({
      state: 'healthy',
      text: 'Updating…',
      sentence: 'Updating the dashboard.',
      updating: true,
    });
  });

  it('while a banner shows: the fixed clock time of the last good sync, in the event timezone, with AM/PM', () => {
    expect(formatClockAmPm(T0, TZ)).toBe('3:42 PM');
    expect(liveLine({ syncedAt: T0, connection: 'error', now: T0 + s(40) }, words)).toEqual({
      state: 'reconnecting',
      text: 'Last updated 3:42 PM',
      sentence: 'Reconnecting. List last updated at 3:42 PM.',
    });
    expect(liveLine({ syncedAt: T0, connection: 'offline', online: false, now: T0 + min(20) }, { ...words, subject: 'Dashboard' })).toEqual({
      state: 'offline',
      text: 'Last updated 3:42 PM',
      sentence: 'Offline. Dashboard last updated at 3:42 PM.',
    });
    // It never moves: an hour later it is still the same time.
    expect(liveLine({ syncedAt: T0, connection: 'error', now: T0 + min(60) }, words).text).toBe('Last updated 3:42 PM');
  });

  it('before the first sync: "Updating…" while it is on its way (fix 1d); nothing while a banner shows', () => {
    expect(liveLine({ syncedAt: null, connection: 'live', now: T0 }, words)).toEqual({ state: 'healthy', text: 'Updating…', sentence: 'Updating the list.', updating: true });
    expect(liveLine({ syncedAt: null, connection: 'offline', online: false, now: T0 }, words)).toEqual({ state: 'offline', text: null, sentence: null });
    expect(liveLine({ syncedAt: null, connection: 'offline', now: T0 }, words)).toEqual({ state: 'reconnecting', text: null, sentence: null });
    // A hidden page shows nothing new (it re-reads when it comes back).
    expect(liveLine({ syncedAt: null, connection: 'live', now: T0, hidden: true }, words).text).toBeNull();
  });

  it('(fix 1d) back in view: "Updating…" until the sync lands when the last one is 15 s old or more; no flicker for a glance', () => {
    const back = (hiddenFor: number, visibleFor = 0) => ({ syncedAt: T0, connection: 'live' as Connection, visibleSince: T0 + hiddenFor, now: T0 + hiddenFor + visibleFor });
    // 10 minutes hidden: Updating… at once, and for as long as the catch-up sync takes (up to the 30 s rule).
    expect(liveLine(back(min(10)), words)).toMatchObject({ state: 'healthy', text: 'Updating…', updating: true });
    expect(liveLine(back(min(10), s(29)), words)).toMatchObject({ state: 'healthy', text: 'Updating…' });
    // Nothing landed in 30 s of visible time: Reconnecting, with the clock time, as before.
    expect(liveLine(back(min(10), s(31)), words)).toMatchObject({ state: 'reconnecting', text: 'Last updated 3:42 PM' });
    // The sync lands: the age again.
    expect(liveLine({ ...back(min(10), s(2)), syncedAt: T0 + min(10) + s(1) }, words)).toMatchObject({ text: 'Updated just now' });
    expect(liveLine({ ...back(min(10), s(2)), syncedAt: T0 + min(10) + s(1) }, words).updating).toBeUndefined();
    // A 10 s glance away (data 10 s old): no flicker.
    expect(liveLine(back(s(10)), words)).toMatchObject({ text: 'Updated just now' });
    // …but if its catch-up sync is still not in at 15 s, Updating…
    expect(liveLine(back(s(10), s(5)), words)).toMatchObject({ text: 'Updating…' });
    // A sync that landed after the page came back is this visit's: never Updating…, however old it gets.
    expect(liveLine({ syncedAt: T0 + s(5), connection: 'live', visibleSince: T0, now: T0 + s(25) }, words)).toMatchObject({ text: 'Updated just now' });
    // Visible since load (no return): the age, as before.
    expect(liveLine({ syncedAt: T0, connection: 'live', now: T0 + s(20) }, words)).toMatchObject({ text: 'Updated just now' });
    // Offline: unchanged.
    expect(liveLine({ ...back(min(10)), online: false }, words)).toMatchObject({ state: 'offline', text: 'Last updated 3:42 PM' });
  });

  it('nextLiveChange: the next minute boundary since the last sync, or the stale moment; nothing while a banner shows', () => {
    // Healthy and fresh: the stale moment (30 s) comes before the first minute boundary.
    expect(nextLiveChange({ syncedAt: T0, connection: 'live', now: T0 + s(6) })).toBe(T0 + STALE_AFTER_MS + 1);
    // Back from the lock screen at 4:59 old: Updating… (fix 1d), whose words wait for the sync or the stale moment.
    const back = { syncedAt: T0, connection: 'live' as Connection, visibleSince: T0 + min(5) - s(1) };
    expect(nextLiveChange({ ...back, now: back.visibleSince })).toBe(back.visibleSince + STALE_AFTER_MS + 1);
    // Back after a 5 s glance: it reads Updating… 15 s after the last sync if the catch-up sync is not in by then.
    expect(nextLiveChange({ syncedAt: T0, connection: 'live', visibleSince: T0 + s(5), now: T0 + s(5) })).toBe(T0 + UPDATING_AFTER_MS);
    // The dashboard, visible since load: the stats' minute boundary.
    expect(nextLiveChange({ syncedAt: T0, aliveAt: T0 + min(4) + s(50), connection: 'live', now: T0 + min(4) + s(59) })).toBe(T0 + min(5));
    // A sync stamped a moment ahead of this clock: the first boundary is a minute after it.
    expect(nextLiveChange({ syncedAt: T0 + 500, connection: 'live', now: T0, visibleSince: T0 + 500 })).toBe(T0 + 500 + STALE_AFTER_MS + 1);
    // Banner states show a fixed time; hidden pages and the first load wait for an event.
    expect(nextLiveChange({ syncedAt: T0, connection: 'error', now: T0 })).toBeNull();
    expect(nextLiveChange({ syncedAt: T0, connection: 'live', online: false, now: T0 })).toBeNull();
    expect(nextLiveChange({ syncedAt: T0, connection: 'live', hidden: true, now: T0 })).toBeNull();
    expect(nextLiveChange({ syncedAt: null, connection: 'live', now: T0 })).toBeNull();
    // The dashboard: the stale moment counts from whatever landed last (the stats or the lists' sync)…
    expect(nextLiveChange({ syncedAt: T0, aliveAt: T0 + s(20), connection: 'live', now: T0 + s(25) })).toBe(T0 + s(20) + STALE_AFTER_MS + 1);
    expect(nextLiveChange({ syncedAt: T0 + s(20), aliveAt: T0, connection: 'live', now: T0 + s(25) })).toBe(T0 + s(20) + STALE_AFTER_MS + 1);
    // …the minute boundaries from the stats (the line's words)…
    expect(nextLiveChange({ syncedAt: T0, aliveAt: T0 + s(59), connection: 'live', now: T0 + s(59) })).toBe(T0 + MINUTE_MS);
    // …and before the first stats only the stale moment can change anything.
    expect(nextLiveChange({ syncedAt: null, aliveAt: T0, connection: 'live', now: T0 + s(5) })).toBe(T0 + STALE_AFTER_MS + 1);
  });
});

// ---------------------------------------------------------------------------------------------------
// The live source: re-renders (new snapshots) at most once a minute while healthy
// ---------------------------------------------------------------------------------------------------

/** A store-like data source and a page the test controls. */
function harness(start: LiveData) {
  let data = start;
  const dataListeners = new Set<() => void>();
  let page: PageVisibility & { online: boolean } = { hidden: false, since: null, online: true };
  const pageListeners = new Set<() => void>();
  const livePage: LivePage = {
    online: () => page.online,
    visibility: () => ({ hidden: page.hidden, since: page.since }),
    subscribe(cb) {
      pageListeners.add(cb);
      return () => pageListeners.delete(cb);
    },
  };
  const source = createLiveSource({
    read: () => data,
    subscribe(cb) {
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    timeZone: TZ,
    page: livePage,
  });
  // What React does: on each notification it reads the snapshot and re-renders only for a new object.
  const renders: LiveLine[] = [];
  let wakes = 0;
  let notifications = 0;
  let fromData = false;
  const off = source.subscribe(() => {
    notifications += 1;
    if (!fromData) wakes += 1;
    const snap = source.getSnapshot();
    if (snap !== renders[renders.length - 1]) renders.push(snap);
  });
  renders.push(source.getSnapshot());
  return {
    source,
    renders,
    get wakes() {
      return wakes;
    },
    get notifications() {
      return notifications;
    },
    setData(patch: Partial<LiveData>) {
      data = { ...data, ...patch };
      fromData = true;
      for (const l of [...dataListeners]) l();
      fromData = false;
    },
    setPage(patch: Partial<typeof page>) {
      page = { ...page, ...patch };
      fromData = true;
      for (const l of [...pageListeners]) l();
      fromData = false;
    },
    off,
  };
}

describe('the live source in fake time', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('healthy with a sync every 6 s for 10 minutes: one render, and its timer never fires', () => {
    const h = harness({ syncedAt: Date.now(), connection: 'live' });
    expect(h.renders.map((r) => r.text)).toEqual(['Updated just now']);
    for (let i = 0; i < 100; i += 1) {
      vi.advanceTimersByTime(s(6));
      // A poll: syncing on, rows, the new sync time, syncing off (several store changes per sync).
      h.setData({ syncedAt: Date.now() });
      h.setData({});
    }
    expect(h.notifications).toBe(200);
    expect(h.wakes).toBe(0);
    expect(h.renders).toHaveLength(1);
    // Exactly one timer is armed: the stale moment, 30 s after the last sync.
    expect(vi.getTimerCount()).toBe(1);
    h.off();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ticks on minute boundaries since the last sync, never per second (the dashboard: stats at 4:59 old, lists live)', () => {
    const syncedAt = T0 - min(5) + s(1);
    const h = harness({ syncedAt, aliveAt: Date.now(), connection: 'live' });
    expect(h.renders.at(-1)?.text).toBe('Updated 4 min ago');
    const rendersBefore = h.renders.length;
    // 999 ms later: no wake, no render.
    vi.advanceTimersByTime(999);
    expect(h.wakes).toBe(0);
    expect(h.renders).toHaveLength(rendersBefore);
    // The 5-minute boundary since the sync: one wake, one render.
    vi.advanceTimersByTime(1);
    expect(h.wakes).toBe(1);
    expect(h.renders.at(-1)?.text).toBe('Updated 5 min ago');
    // Nothing more until it turns stale, 30 s after the lists' last sync.
    vi.advanceTimersByTime(s(28));
    expect(h.wakes).toBe(1);
    vi.advanceTimersByTime(s(1) + 1);
    expect(h.wakes).toBe(2);
    expect(h.renders.at(-1)).toMatchObject({ state: 'reconnecting', text: `Last updated ${formatClockAmPm(syncedAt, TZ)}` });
    // A banner state shows a fixed time: no timer at all, so no render for as long as it lasts.
    expect(vi.getTimerCount()).toBe(0);
    const settled = h.renders.length;
    vi.advanceTimersByTime(min(30));
    expect(h.renders).toHaveLength(settled);
    // A sync lands: healthy again, "Updated just now".
    h.setData({ syncedAt: Date.now() });
    expect(h.renders.at(-1)).toMatchObject({ state: 'healthy', text: 'Updated just now' });
    h.off();
  });

  it('a healthy line renders at most once a minute (minute labels are stable between boundaries)', () => {
    // A long healthy stretch with an old sync: the dashboard, its stats not moving while the lists' syncs land.
    // Over 10 minutes the label may change only on minute boundaries.
    const h = harness({ syncedAt: Date.now(), aliveAt: Date.now(), connection: 'live' });
    const changes: number[] = [];
    let seen = h.renders.length;
    for (let t = 0; t < min(10); t += s(1)) {
      if (t % s(20) === 0) h.setData({ aliveAt: Date.now() }); // the lists sync: never stale
      vi.advanceTimersByTime(s(1));
      if (h.renders.length !== seen) {
        changes.push(Date.now() - T0);
        seen = h.renders.length;
      }
    }
    expect(h.renders.every((r) => r.state === 'healthy')).toBe(true);
    // One render per minute boundary (1 min … 9 min, then 10 min at the very end), never in between.
    expect(changes.length).toBeLessThanOrEqual(10);
    for (const at of changes) expect(at % MINUTE_MS).toBe(0);
    expect(h.renders.at(-1)?.text).toBe('Updated 10 min ago');
    h.off();
  });

  it('a hidden page arms no timer; coming back counts 30 s from then', () => {
    const h = harness({ syncedAt: Date.now(), connection: 'live' });
    h.setPage({ hidden: true });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(min(10));
    expect(h.renders.at(-1)?.state).toBe('healthy');
    h.setPage({ hidden: false, since: Date.now() });
    // (fix 1d) 10 minutes away: Updating… while the catch-up sync runs, not "Updated 10 min ago".
    expect(h.renders.at(-1)).toMatchObject({ state: 'healthy', text: 'Updating…', updating: true });
    vi.advanceTimersByTime(STALE_AFTER_MS + 1);
    expect(h.renders.at(-1)?.state).toBe('reconnecting');
    h.off();
  });

  it('(fix 1d) 10 minutes hidden: Updating… until the sync lands, then "Updated just now"; a 10 s glance never flickers', () => {
    const h = harness({ syncedAt: Date.now(), connection: 'live' });
    h.setPage({ hidden: true });
    vi.advanceTimersByTime(min(10));
    h.setPage({ hidden: false, since: Date.now() });
    expect(h.renders.at(-1)?.text).toBe('Updating…');
    vi.advanceTimersByTime(s(2));
    h.setData({ syncedAt: Date.now() });
    expect(h.renders.at(-1)).toMatchObject({ state: 'healthy', text: 'Updated just now' });
    const settled = h.renders.length;
    // A 10 s glance away and back: the same words, no render.
    h.setPage({ hidden: true });
    vi.advanceTimersByTime(s(10));
    h.setPage({ hidden: false, since: Date.now() });
    expect(h.renders).toHaveLength(settled);
    // Its catch-up sync is slow: at 15 s since the last sync the line wakes and reads Updating…
    vi.advanceTimersByTime(s(5) - 1);
    expect(h.renders).toHaveLength(settled);
    vi.advanceTimersByTime(1);
    expect(h.renders.at(-1)?.text).toBe('Updating…');
    h.setData({ syncedAt: Date.now() });
    expect(h.renders.at(-1)?.text).toBe('Updated just now');
    h.off();
  });

  it('offline and back: the same object for the banner and the line, announced once each way', () => {
    const h = harness({ syncedAt: Date.now(), connection: 'live' });
    h.setPage({ online: false });
    h.setData({ connection: 'offline' });
    const offline = h.renders.at(-1)!;
    expect(offline).toMatchObject({ state: 'offline', text: 'Last updated 3:42 PM' });
    // Requests failing while offline change nothing on screen.
    h.setData({ connection: 'error' });
    expect(h.renders.at(-1)).toBe(offline);
    h.setPage({ online: true });
    expect(h.renders.at(-1)?.state).toBe('reconnecting');
    h.setData({ connection: 'live', syncedAt: Date.now() });
    expect(h.renders.at(-1)).toMatchObject({ state: 'healthy', text: 'Updated just now' });
    const states = h.renders.map((r) => r.state);
    expect(states).toEqual(['healthy', 'offline', 'reconnecting', 'healthy']);
    const said = states.slice(1).map((to, i) => liveAnnouncement(states[i]!, to));
    expect(said).toEqual(['Offline', 'Reconnecting', 'Back online']);
    h.off();
  });
});

// ---------------------------------------------------------------------------------------------------
// Refresh now
// ---------------------------------------------------------------------------------------------------

function syncingStore(syncing = false) {
  let state = { syncing };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(next: boolean) {
      state = { syncing: next };
      for (const l of [...listeners]) l();
    },
    get listeners() {
      return listeners.size;
    },
  };
}

describe('watchRefresh: when the sync a Refresh tap asked for has finished', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('idle at the tap: done when the sync it started ends, once', () => {
    const store = syncingStore();
    const done = vi.fn();
    watchRefresh(store, done);
    vi.advanceTimersByTime(30);
    store.set(true);
    vi.advanceTimersByTime(s(5));
    expect(done).not.toHaveBeenCalled();
    store.set(false);
    expect(done).toHaveBeenCalledTimes(1);
    store.set(true);
    store.set(false);
    expect(done).toHaveBeenCalledTimes(1);
    expect(store.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a poll in flight at the tap is not the one: waits for the sync the store runs right after it', () => {
    const store = syncingStore(true);
    const done = vi.fn();
    watchRefresh(store, done);
    store.set(false);
    expect(done).not.toHaveBeenCalled();
    store.set(true);
    vi.advanceTimersByTime(REFRESH_START_GRACE_MS * 3);
    expect(done).not.toHaveBeenCalled();
    store.set(false);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('no sync starts (offline, signed out): done after a moment', () => {
    const store = syncingStore();
    const done = vi.fn();
    watchRefresh(store, done);
    vi.advanceTimersByTime(REFRESH_START_GRACE_MS - 1);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('a sync that never ends: done at the cap; stop() ends the watch without done', () => {
    const store = syncingStore();
    const done = vi.fn();
    watchRefresh(store, done);
    store.set(true);
    vi.advanceTimersByTime(REFRESH_MAX_MS);
    expect(done).toHaveBeenCalledTimes(1);

    const other = syncingStore();
    const never = vi.fn();
    const stop = watchRefresh(other, never);
    stop();
    other.set(true);
    other.set(false);
    vi.advanceTimersByTime(REFRESH_MAX_MS);
    expect(never).not.toHaveBeenCalled();
    expect(other.listeners).toBe(0);
  });

  it('the glyph finishes the turn it is in (one whole turn at least)', () => {
    expect(SPIN_MS).toBe(800);
    expect(spinStopDelay(0)).toBe(800);
    expect(spinStopDelay(120)).toBe(680);
    expect(spinStopDelay(800)).toBe(0);
    expect(spinStopDelay(801)).toBe(799);
    expect(spinStopDelay(2_300)).toBe(100);
  });
});
