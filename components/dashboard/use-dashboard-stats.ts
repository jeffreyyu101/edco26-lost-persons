'use client';
// Dashboard v4's stats: GET /api/stats?range=… every 15 s through the shared poller (lib/client/stats-poller.ts: the
// lists' failure thresholds, a fetch at once when the connection comes back), paused while the page is hidden. Each
// poll sends the last ETag back; a 304 keeps the numbers on screen. A 401 goes through the store, which ends the
// session as for every other request. Loaded with the dashboard, never on the first load.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Stats, StatsRange } from '@/lib/api-types';
import { SYNC, STATS_POLL_MS } from '@/lib/client/constants';
import { readVisibility, subscribeVisibility } from '@/lib/client/live-status';
import type { StatsState } from '@/lib/client/stats-poller';
import { useAppStore } from '@/lib/client/store-contract';

class StatsFetchError extends Error {
  constructor(readonly reason: 'offline' | 'failed') {
    super(reason);
  }
}

export interface DashboardStats extends StatsState {
  /** Server clock minus this device's clock (ms), so the timers tick from the server's times. */
  skew: number;
  refresh: () => Promise<void>;
}

const EMPTY: Omit<DashboardStats, 'refresh'> = { stats: null, updatedAt: null, error: false, failing: false, skew: 0 };
const idle = () => Promise.resolve();

export function useDashboardStats(range: StatsRange): DashboardStats {
  const store = useAppStore();
  const [state, setState] = useState(EMPTY);
  const runRef = useRef<() => Promise<void>>(idle);
  const refresh = useCallback(() => runRef.current(), []);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    let etag: string | null = null;
    let last: Stats | null = null;
    let skew = 0;

    const fetchStats = async (): Promise<Stats> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SYNC.requestTimeoutMs);
      let res: Response;
      try {
        res = await fetch(`/api/stats?range=${range}`, {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { Accept: 'application/json', ...(etag && last ? { 'If-None-Match': etag } : {}) },
          signal: controller.signal,
        });
      } catch {
        throw new StatsFetchError('offline');
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 304 && last) return last;
      if (res.status === 401) return store.actions.fetchStats(); // the store signs this device out ('unauthorized')
      // A captive portal (festival Wi-Fi) redirects or answers 511; neither is our API.
      if (res.redirected || res.status === 511) throw new StatsFetchError('offline');
      if (!res.ok) throw new StatsFetchError('failed');
      const data = (await res.json().catch(() => null)) as Stats | null;
      if (!data || typeof data !== 'object') throw new StatsFetchError('offline');
      etag = res.headers.get('etag');
      last = data;
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
