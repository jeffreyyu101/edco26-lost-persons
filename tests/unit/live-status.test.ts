// The live indicator's state and words (lib/client/live-status.ts; design/screens/live-indicator.html):
// "Updated now / 6s ago / 2m ago", the 30 s stale threshold, Reconnecting, Offline, the once-a-second clock.
// Fake timers drive the clock; no DOM, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JUST_NOW_MS,
  LIVE_TICK_MS,
  STALE_AFTER_MS,
  agoLong,
  agoShort,
  liveAnnouncement,
  liveLine,
  liveState,
  readDeviceOnline,
  readSecondClock,
  subscribeSecondClock,
} from '@/lib/client/live-status';

const T0 = Date.parse('2026-11-06T20:00:00Z');
const s = (n: number) => n * 1_000;

describe('agoShort / agoLong: the relative time', () => {
  it('under 2 s is "now" (a sync landing between two ticks, a negative age, too)', () => {
    expect(JUST_NOW_MS).toBe(2_000);
    for (const age of [-1_500, 0, 1, 999, 1_000, 1_999]) {
      expect(agoShort(age), String(age)).toBe('now');
      expect(agoLong(age), String(age)).toBe('just now');
    }
  });

  it('2–59 s in whole seconds', () => {
    expect(agoShort(2_000)).toBe('2s ago');
    expect(agoShort(6_000)).toBe('6s ago');
    expect(agoShort(6_999)).toBe('6s ago');
    expect(agoShort(59_999)).toBe('59s ago');
    expect(agoLong(2_000)).toBe('2 seconds ago');
    expect(agoLong(6_400)).toBe('6 seconds ago');
    expect(agoLong(59_999)).toBe('59 seconds ago');
  });

  it('minutes from 60 s, hours from 60 min (singular in the sentence)', () => {
    expect(agoShort(60_000)).toBe('1m ago');
    expect(agoShort(119_999)).toBe('1m ago');
    expect(agoShort(120_000)).toBe('2m ago');
    expect(agoShort(59 * 60_000 + 59_999)).toBe('59m ago');
    expect(agoShort(60 * 60_000)).toBe('1h ago');
    expect(agoShort(3 * 3_600_000 + 5 * 60_000)).toBe('3h ago');
    expect(agoLong(60_000)).toBe('1 minute ago');
    expect(agoLong(5 * 60_000)).toBe('5 minutes ago');
    expect(agoLong(3_600_000)).toBe('1 hour ago');
    expect(agoLong(2 * 3_600_000)).toBe('2 hours ago');
  });
});

describe('liveState', () => {
  const base = { syncedAt: T0, connection: 'live' as const, now: T0 };

  it('nothing before the first sync, whatever the connection', () => {
    expect(liveState({ ...base, syncedAt: null })).toBeNull();
    expect(liveState({ ...base, syncedAt: null, connection: 'offline', online: false })).toBeNull();
    expect(liveState({ ...base, syncedAt: null, connection: 'error' })).toBeNull();
    expect(liveLine({ ...base, syncedAt: null })).toBeNull();
  });

  it('live while syncs land; Reconnecting once the last one is more than 30 s old', () => {
    expect(STALE_AFTER_MS).toBe(30_000);
    expect(liveState({ ...base, now: T0 })).toBe('live');
    expect(liveState({ ...base, now: T0 + s(29) })).toBe('live');
    expect(liveState({ ...base, now: T0 + STALE_AFTER_MS })).toBe('live');
    expect(liveState({ ...base, now: T0 + STALE_AFTER_MS + 1 })).toBe('reconnecting');
    expect(liveState({ ...base, now: T0 + s(120) })).toBe('reconnecting');
  });

  it("Reconnecting at once when the log can't be reached, or the view's own fetch fails", () => {
    expect(liveState({ ...base, connection: 'error' })).toBe('reconnecting');
    expect(liveState({ ...base, failing: true })).toBe('reconnecting');
    // Requests fail while the phone reports a connection (the store calls that 'offline' after two).
    expect(liveState({ ...base, connection: 'offline', online: true })).toBe('reconnecting');
  });

  it('Offline when the phone reports no connection, before any staleness or error', () => {
    expect(liveState({ ...base, connection: 'offline', online: false })).toBe('offline');
    expect(liveState({ ...base, connection: 'live', online: false })).toBe('offline');
    expect(liveState({ ...base, connection: 'error', online: false, now: T0 + s(300) })).toBe('offline');
  });

  it('staleness counts visible time only: back from the lock screen is live until 30 s pass', () => {
    const syncedAt = T0;
    const visibleSince = T0 + s(600);
    expect(liveState({ syncedAt, connection: 'live', now: visibleSince + s(1), visibleSince })).toBe('live');
    expect(liveState({ syncedAt, connection: 'live', now: visibleSince + STALE_AFTER_MS, visibleSince })).toBe('live');
    expect(liveState({ syncedAt, connection: 'live', now: visibleSince + STALE_AFTER_MS + 1, visibleSince })).toBe('reconnecting');
    // An older visibility doesn't stretch a newer sync.
    expect(liveState({ syncedAt: T0, connection: 'live', now: T0 + s(31), visibleSince: T0 - s(100) })).toBe('reconnecting');
  });
});

describe('liveLine: what the line shows and says', () => {
  it('live: "Updated now", "Updated 6s ago", "Updated 2m ago" can only be live up to 30 s', () => {
    expect(liveLine({ syncedAt: T0, connection: 'live', now: T0 })).toEqual({
      state: 'live',
      lead: null,
      text: 'Updated now',
      sentence: 'List updated just now',
    });
    expect(liveLine({ syncedAt: T0, connection: 'live', now: T0 + s(6) })).toEqual({
      state: 'live',
      lead: null,
      text: 'Updated 6s ago',
      sentence: 'List updated 6 seconds ago',
    });
  });

  it('Reconnecting: the lead, then the last good time', () => {
    expect(liveLine({ syncedAt: T0, connection: 'live', now: T0 + s(125) })).toEqual({
      state: 'reconnecting',
      lead: 'Reconnecting',
      text: ' · updated 2m ago',
      sentence: 'Reconnecting. List updated 2 minutes ago',
    });
    expect(liveLine({ syncedAt: T0, connection: 'error', now: T0 + s(8) })?.text).toBe(' · updated 8s ago');
  });

  it('Offline: the lead, then the last good time; the subject starts the sentence', () => {
    expect(liveLine({ syncedAt: T0, connection: 'offline', online: false, now: T0 + s(300) }, 'Dashboard')).toEqual({
      state: 'offline',
      lead: 'Offline',
      text: ' · updated 5m ago',
      sentence: 'Offline. Dashboard updated 5 minutes ago',
    });
  });

  it('the live region words are the state only', () => {
    expect(liveAnnouncement('live')).toBe('List is live');
    expect(liveAnnouncement('live', 'Dashboard')).toBe('Dashboard is live');
    expect(liveAnnouncement('reconnecting')).toBe('Reconnecting');
    expect(liveAnnouncement('offline')).toBe('Offline');
  });

  it('in fake time: ticks 0–59 s, then minutes; Reconnecting after 30 s without a sync; back to live on a sync', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      let syncedAt = Date.now();
      const line = () => liveLine({ syncedAt, connection: 'live', now: Date.now() });
      expect(line()?.text).toBe('Updated now');
      vi.advanceTimersByTime(1_999);
      expect(line()?.text).toBe('Updated now');
      vi.advanceTimersByTime(1);
      expect(line()?.text).toBe('Updated 2s ago');
      vi.advanceTimersByTime(4_000);
      expect(line()?.text).toBe('Updated 6s ago');
      // A sync lands.
      syncedAt = Date.now();
      expect(line()?.text).toBe('Updated now');
      vi.advanceTimersByTime(30_000);
      expect(line()?.state).toBe('live');
      vi.advanceTimersByTime(1);
      expect(line()).toMatchObject({ state: 'reconnecting', text: ' · updated 30s ago' });
      vi.advanceTimersByTime(29_999);
      expect(line()?.text).toBe(' · updated 1m ago');
      vi.advanceTimersByTime(60_000);
      expect(line()?.text).toBe(' · updated 2m ago');
      syncedAt = Date.now();
      expect(line()).toMatchObject({ state: 'live', text: 'Updated now' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the once-a-second clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks once a second while subscribed, and stops when the last subscriber leaves', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeSecondClock(a);
    const offB = subscribeSecondClock(b);
    const first = readSecondClock();
    expect(readSecondClock()).toBe(first); // the same object until the next tick
    vi.advanceTimersByTime(LIVE_TICK_MS - 1);
    expect(a).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(readSecondClock().now).toBe(T0 + LIVE_TICK_MS);
    vi.advanceTimersByTime(3 * LIVE_TICK_MS);
    expect(a).toHaveBeenCalledTimes(4);
    offA();
    vi.advanceTimersByTime(LIVE_TICK_MS);
    expect(a).toHaveBeenCalledTimes(4);
    expect(b).toHaveBeenCalledTimes(5);
    offB();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * LIVE_TICK_MS);
    expect(b).toHaveBeenCalledTimes(5);
  });

  it('with nothing subscribed, a read is brought up to date (at most once a second)', () => {
    vi.advanceTimersByTime(5 * 60_000);
    const fresh = readSecondClock();
    expect(fresh.now).toBe(Date.now());
    // Reads within the same second return the same object (a stable snapshot for React).
    vi.advanceTimersByTime(LIVE_TICK_MS - 1);
    expect(readSecondClock()).toBe(fresh);
    vi.advanceTimersByTime(1);
    expect(readSecondClock()).not.toBe(fresh);
    expect(readSecondClock().now).toBe(Date.now());
  });

  it('reads the phone as online where navigator.onLine is unknown', () => {
    expect(readDeviceOnline()).toBe(true);
  });
});
