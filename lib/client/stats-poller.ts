// The dashboard's stats poller behind useStats() (store-contract.ts): GET /api/stats every 15 s, Refresh now,
// and the connection rules of the lists (v2.2 afternoon review fix, 2026-11-06):
//   - `failing` (the dashboard's Reconnecting) needs the lists' thresholds: 2 network failures or timeouts, or
//     3 server errors, in a row (CONNECTION_FAILURES). One 503 or one timed-out poll shows nothing.
//   - When the connection comes back (the phone's 'online' event, or the store's connection back to 'live') and
//     the last fetch failed, it fetches at once, so the dashboard recovers with the lists instead of at the next
//     poll up to 15 s later. Like the store, 'online' forgets the network failures counted while offline.
//   - (Dashboard v4) While the page is hidden no poll goes out; it fetches at once when the page shows again.
// A plain module, not a hook, so the unit tests drive it with fake timers.
import type { EventStats } from '../api-types';
import { CONNECTION_FAILURES } from './constants';
import type { Connection } from './store-contract';

export interface StatsState {
  stats: EventStats | null;
  /** This phone's clock (epoch ms) when the last fetch succeeded. */
  updatedAt: number | null;
  /** The last fetch failed (the empty "Can't reach the log" state while nothing has loaded). */
  error: boolean;
  /** Fetches failed past the lists' thresholds: Reconnecting. */
  failing: boolean;
}

export const INITIAL_STATS_STATE: StatsState = { stats: null, updatedAt: null, error: false, failing: false };

export interface StatsPollerOptions {
  fetchStats: () => Promise<EventStats>;
  /** Every change of the state (not called after stop()). */
  onChange: (state: StatsState) => void;
  /** Calls back when the connection comes back (subscribeReconnect below). */
  subscribeReconnect?: (onReconnect: () => void) => () => void;
  pollMs: number;
  /** (v4) The page's visibility (lib/client/live-status.ts readVisibility / subscribeVisibility). */
  visibility?: { hidden(): boolean; subscribe(onChange: () => void): () => void };
}

export interface StatsPoller {
  /** Fetches at once (joining a fetch already on its way) and resolves when it has settled; the next poll is pollMs after it. */
  refresh(): Promise<void>;
  stop(): void;
}

/** How a failed fetch counts: the store's FetchError reason 'offline' is a network failure or a timeout. */
function failureKind(error: unknown): 'network' | 'http' | null {
  const reason = (error as { reason?: unknown } | null)?.reason;
  if (reason === 'unauthorized') return null; // the session ended: the store signs this phone out
  return reason === 'offline' ? 'network' : 'http';
}

/** Starts polling at once. */
export function startStatsPoller({ fetchStats, onChange, subscribeReconnect, pollMs, visibility }: StatsPollerOptions): StatsPoller {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  let lastOk = false;
  let netFailures = 0;
  let httpFailures = 0;
  /** Bumped when the connection comes back: a fetch that went out before then doesn't count as a failure. */
  let epoch = 0;
  let state = INITIAL_STATS_STATE;

  const publish = (patch: Partial<StatsState>) => {
    const failing = netFailures >= CONNECTION_FAILURES.network || httpFailures >= CONNECTION_FAILURES.http;
    const next = { ...state, ...patch, failing };
    if (next.stats === state.stats && next.updatedAt === state.updatedAt && next.error === state.error && next.failing === state.failing) return;
    state = next;
    if (live) onChange(state);
  };

  const fetchOnce = () => {
    inFlight ??= (async () => {
      const startedIn = epoch;
      try {
        const stats = await fetchStats();
        if (!live) return;
        lastOk = true;
        netFailures = 0;
        httpFailures = 0;
        publish({ stats, updatedAt: Date.now(), error: false });
      } catch (error) {
        if (!live) return;
        lastOk = false;
        // As the store counts its syncs: a server error resets the network count.
        const kind = startedIn === epoch ? failureKind(error) : null;
        if (kind === 'network') netFailures += 1;
        if (kind === 'http') {
          httpFailures += 1;
          netFailures = 0;
        }
        publish({ error: true });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
  const tick = async () => {
    await fetchOnce();
    if (live && !timer && !visibility?.hidden()) timer = setTimeout(next, pollMs);
  };
  function next() {
    timer = undefined;
    void tick();
  }
  const now = () => {
    if (!live) return Promise.resolve();
    if (timer) clearTimeout(timer);
    timer = undefined;
    return tick();
  };
  const reconnect = async () => {
    if (!live) return;
    epoch += 1;
    netFailures = 0;
    publish({});
    // A fetch already on its way may have gone out before the connection was back: one more if it fails.
    if (inFlight) await inFlight;
    if (live && !lastOk) await now();
  };

  const offReconnect = subscribeReconnect?.(() => void reconnect()) ?? (() => {});
  // Hidden: the pending poll is dropped; shown again: one fetch at once, then the usual rhythm.
  const offVisibility =
    visibility?.subscribe(() => {
      if (!live) return;
      if (visibility.hidden()) {
        if (timer) clearTimeout(timer);
        timer = undefined;
      } else if (!timer && !inFlight) void tick();
    }) ?? (() => {});
  void tick();
  return {
    refresh: now,
    stop() {
      live = false;
      offReconnect();
      offVisibility();
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export interface ConnectionStore {
  getState(): { connection: Connection };
  subscribe(listener: () => void): () => void;
}

/** Where the phone's 'online' event comes from (the window; tests pass their own EventTarget). */
export type OnlineEvents = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Calls back when the connection comes back: the phone's 'online' event (the stats then go out alongside the
 * store's own catch-up sync), and the store's connection turning 'live' again (no 'online' event comes when
 * requests failed while the phone still reported a connection).
 */
export function subscribeReconnect(
  store: ConnectionStore,
  onReconnect: () => void,
  events: OnlineEvents | undefined = typeof window === 'undefined' ? undefined : window,
): () => void {
  let connection = store.getState().connection;
  const offStore = store.subscribe(() => {
    const next = store.getState().connection;
    const back = connection !== 'live' && next === 'live';
    connection = next;
    if (back) onReconnect();
  });
  const onOnline = () => onReconnect();
  events?.addEventListener('online', onOnline);
  return () => {
    offStore();
    events?.removeEventListener('online', onOnline);
  };
}
