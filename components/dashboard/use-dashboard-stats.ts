'use client';
// Dashboard v4's stats: GET /api/stats?range=… every 15 s through the shared poller (lib/client/stats-poller.ts: the
// lists' failure thresholds, a fetch at once when the connection comes back), paused while the page is hidden. The
// fetch is the store's (session-safe: held during a sign-out, stale answers dropped, a 401 ends the session).
// Loaded with the dashboard, never on the first load.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EventStats, EventStatsRange } from '@/lib/api-types';
import { STATS_POLL_MS } from '@/lib/client/constants';
import { readVisibility, subscribeVisibility } from '@/lib/client/live-status';
import type { StatsState } from '@/lib/client/stats-poller';
import { useAppStore } from '@/lib/client/store-contract';

export interface DashboardStats extends StatsState {
  /** Server clock minus this device's clock (ms), so the timers tick from the server's times. */
  skew: number;
  refresh: () => Promise<void>;
}

const EMPTY: Omit<DashboardStats, 'refresh'> = { stats: null, updatedAt: null, error: false, failing: false, skew: 0 };
const idle = () => Promise.resolve();

export function useDashboardStats(range: EventStatsRange): DashboardStats {
  const store = useAppStore();
  const [state, setState] = useState(EMPTY);
  const runRef = useRef<() => Promise<void>>(idle);
  const refresh = useCallback(() => runRef.current(), []);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    let skew = 0;

    // Through the store, like every other request: nothing goes out while a sign-out is pending, an answer for a
    // previous staff is dropped, and a 401 ends the session ('unauthorized').
    const fetchStats = async (): Promise<EventStats> => {
      const data = await store.actions.fetchStats(range);
      const server = Date.parse(data.serverTime);
      skew = Number.isFinite(server) ? server - Date.now() : 0;
      return data;
    };

    import('@/lib/client/stats-poller').then(
      ({ startStatsPoller, subscribeReconnect }) => {
        if (!live) return;
        const poller = startStatsPoller({
          fetchStats,
          // A failed first fetch of a new range keeps the last numbers on screen.
          onChange: (next) => setState((prev) => ({ ...next, stats: next.stats ?? prev.stats, skew })),
          subscribeReconnect: (onReconnect) => subscribeReconnect(store, onReconnect),
          pollMs: STATS_POLL_MS,
          visibility: { hidden: () => readVisibility().hidden, subscribe: subscribeVisibility },
        });
        runRef.current = poller.refresh;
        stop = poller.stop;
      },
      () => {
        if (live) setState((s) => ({ ...s, error: true }));
      },
    );
    return () => {
      live = false;
      stop?.();
      runRef.current = idle;
    };
  }, [store, range]);

  return { ...state, refresh };
}
