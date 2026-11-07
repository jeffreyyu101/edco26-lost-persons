// The dashboard's stats poller (lib/client/stats-poller.ts; v2.2 afternoon review fix): the lists' thresholds
// before the dashboard reads Reconnecting (one 503 or one timed-out poll shows nothing; 2 network failures or
// 3 server errors in a row do), and a fetch at once when the connection comes back, instead of the next poll
// up to 15 s later. Fake timers; no DOM, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stats } from '@/lib/api-types';
import { liveState } from '@/lib/client/live-status';
import { CONNECTION_FAILURES, STATS_POLL_MS, type Connection } from '@/lib/client/store-contract';
import { startStatsPoller, subscribeReconnect, type StatsState } from '@/lib/client/stats-poller';

const T0 = Date.parse('2026-11-06T20:42:00Z');
const s = (n: number) => n * 1_000;
const STATS = { total: 1 } as unknown as Stats;

type Outcome = 'ok' | 'offline' | 'failed' | 'unauthorized';

/** fetchStats answering from a script (then 'ok'), each after `latencyMs`; counts the calls. */
function scriptedFetch(script: Outcome[], latencyMs = 100) {
  const queue = [...script];
  let calls = 0;
  const fetchStats = () => {
    calls += 1;
    const outcome = queue.shift() ?? 'ok';
    return new Promise<Stats>((resolve, reject) =>
      setTimeout(() => (outcome === 'ok' ? resolve(STATS) : reject(Object.assign(new Error(outcome), { reason: outcome }))), latencyMs),
    );
  };
  return {
    fetchStats,
    push: (...more: Outcome[]) => queue.push(...more),
    get calls() {
      return calls;
    },
  };
}

function connectionStore(connection: Connection = 'live') {
  let state = { connection };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(next: Connection) {
      state = { connection: next };
      for (const l of [...listeners]) l();
    },
  };
}

function poller(script: Outcome[], { latencyMs = 100, connection = 'live' as Connection } = {}) {
  const api = scriptedFetch(script, latencyMs);
  const store = connectionStore(connection);
  const events = new EventTarget();
  const states: StatsState[] = [];
  const p = startStatsPoller({
    fetchStats: api.fetchStats,
    onChange: (state) => states.push(state),
    subscribeReconnect: (onReconnect) => subscribeReconnect(store, onReconnect, events),
    pollMs: STATS_POLL_MS,
  });
  return {
    api,
    store,
    states,
    poller: p,
    get state() {
      return states.at(-1)!;
    },
    online: () => events.dispatchEvent(new Event('online')),
  };
}

/** Lets the poll in flight answer (and the promise chain after it settle). */
const settle = async (latencyMs = 100) => {
  await vi.advanceTimersByTimeAsync(latencyMs);
};

describe('the dashboard stats poller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the same thresholds as the lists', () => {
    expect(CONNECTION_FAILURES).toEqual({ network: 2, http: 3 });
  });

  it('one 503 or one timed-out poll is not failing; the next good poll clears the error', async () => {
    for (const once of ['failed', 'offline'] as const) {
      const h = poller(['ok', once]);
      await settle();
      expect(h.state).toMatchObject({ stats: STATS, updatedAt: T0 + 100, error: false, failing: false });
      await vi.advanceTimersByTimeAsync(STATS_POLL_MS + 100);
      expect(h.state, once).toMatchObject({ error: true, failing: false, updatedAt: T0 + 100 });
      await vi.advanceTimersByTimeAsync(STATS_POLL_MS + 100);
      expect(h.state, once).toMatchObject({ error: false, failing: false });
      expect(h.states.some((st) => st.failing), once).toBe(false);
      h.poller.stop();
      vi.setSystemTime(T0);
    }
  });

  it('2 network failures or timeouts in a row are failing (the store: offline)', async () => {
    const h = poller(['ok', 'offline', 'offline']);
    await settle();
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS + 100);
    expect(h.state.failing).toBe(false);
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS + 100);
    expect(h.state).toMatchObject({ error: true, failing: true });
    // A good poll: back at once.
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS + 100);
    expect(h.state).toMatchObject({ error: false, failing: false });
    h.poller.stop();
  });

  it('3 server errors in a row are failing (the store: error); a server error resets the network count', async () => {
    const h = poller(['ok', 'failed', 'failed', 'offline', 'failed']);
    await settle();
    const failingAfter: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(STATS_POLL_MS + 100);
      failingAfter.push(h.state.failing);
    }
    // 503, 503: not yet. A timeout: 1 network failure (the server errors still count, as in the store). The
    // 3rd server error: failing.
    expect(failingAfter).toEqual([false, false, false, true]);
    h.poller.stop();

    const k = poller(['ok', 'offline', 'failed', 'offline']);
    await settle();
    const after: boolean[] = [];
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(STATS_POLL_MS + 100);
      after.push(k.state.failing);
    }
    // Timeout, 503 (resets the network count), timeout: never 2 network failures in a row, 1 server error.
    expect(after).toEqual([false, false, false]);
    k.poller.stop();
  });

  it('a 401 counts as nothing (the store signs the phone out)', async () => {
    const h = poller(['unauthorized', 'unauthorized', 'unauthorized']);
    for (let i = 0; i < 3; i += 1) await vi.advanceTimersByTimeAsync(STATS_POLL_MS + 100);
    expect(h.state).toMatchObject({ error: true, failing: false });
    h.poller.stop();
  });

  it('back online after polls failed offline: fetches at once, not at the next 15 s poll', async () => {
    const h = poller(['ok', 'offline', 'offline']);
    await settle();
    await vi.advanceTimersByTimeAsync(2 * (STATS_POLL_MS + 100));
    expect(h.state.failing).toBe(true);
    const calls = h.api.calls;
    // 'online': the network failures counted offline are forgotten at once (as the store does), and the stats
    // go out right away.
    h.online();
    expect(h.state.failing).toBe(false);
    expect(h.api.calls).toBe(calls + 1);
    await settle();
    expect(h.state).toMatchObject({ error: false, failing: false, updatedAt: Date.now() });
    // The next poll is 15 s after that one, not sooner.
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS - 1);
    expect(h.api.calls).toBe(calls + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.api.calls).toBe(calls + 2);
    h.poller.stop();
  });

  it("the store's connection back to 'live' after a failed fetch: fetches at once; after a good one: nothing extra", async () => {
    const h = poller(['ok', 'failed'], { connection: 'live' });
    await settle();
    h.store.set('error');
    // The last fetch was good: the connection coming back fetches nothing.
    h.store.set('live');
    expect(h.api.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS + 100);
    expect(h.state.error).toBe(true);
    h.store.set('error');
    h.store.set('live');
    await settle(0);
    expect(h.api.calls).toBe(3);
    await settle();
    expect(h.state.error).toBe(false);
    h.poller.stop();
  });

  it('a fetch on its way when the connection comes back joins it, then fetches once more if it failed', async () => {
    const h = poller(['ok', 'offline', 'offline'], { latencyMs: s(2) });
    await settle(s(2));
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS + s(1));
    // The 2nd fetch is on its way (it went out offline and will fail).
    expect(h.api.calls).toBe(2);
    h.online();
    expect(h.api.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(s(1));
    // It failed: one more right away.
    expect(h.api.calls).toBe(3);
    // That one fails too: 1 network failure since 'online' (the one that went out offline doesn't count).
    await vi.advanceTimersByTimeAsync(s(2));
    expect(h.state).toMatchObject({ error: true, failing: false });
    // The next poll fails as well: 2 in a row since the connection came back.
    h.api.push('offline');
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS + s(2));
    expect(h.api.calls).toBe(4);
    expect(h.state.failing).toBe(true);
    h.poller.stop();
  });

  it('Refresh now joins a fetch on its way; nothing is reported after stop()', async () => {
    const h = poller([]);
    const joined = h.poller.refresh();
    expect(h.api.calls).toBe(1);
    await settle();
    await joined;
    const seen = h.states.length;
    h.poller.stop();
    h.online();
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS * 4);
    expect(h.api.calls).toBe(1);
    expect(h.states).toHaveLength(seen);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the review scenario: a one-off failed or timed-out poll, with the lists syncing, never shows Reconnecting', async () => {
    // The 12 s timeout: the poll at 15 s fails at 27 s; the next lands at 42 s. The lists synced every 6 s meanwhile.
    for (const latencyMs of [100, s(12)]) {
      vi.setSystemTime(T0);
      const h = poller(['ok', 'offline'], { latencyMs });
      let listSyncedAt = Date.now();
      const states = new Set<string>();
      for (let t = 0; t < s(60); t += s(1)) {
        await vi.advanceTimersByTimeAsync(s(1));
        if (t % s(6) === 0) listSyncedAt = Date.now();
        states.add(
          liveState({ syncedAt: h.state?.updatedAt ?? null, aliveAt: listSyncedAt, connection: 'live', failing: h.state?.failing ?? false, now: Date.now() }),
        );
      }
      expect([...states], String(latencyMs)).toEqual(['healthy']);
      h.poller.stop();
    }
  });
});
