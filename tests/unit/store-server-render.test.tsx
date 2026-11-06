// Server-render invariants of the store (spec A38): StoreProvider also renders on the server, so building
// the store must start nothing, side effects begin in start() (client, after hydration), and the server
// HTML / hydration read getServerState(), never what only the phone knows.
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  StoreContext,
  createServerState,
  useConnection,
  useOutbox,
  usePrefs,
  type AppStore,
  type StoreState,
} from '@/lib/client/store-contract';
import { DEFAULT_PREFS } from '@/lib/client/prefs';

const TZ = 'America/New_York';

// What a phone that reloads offline would know before hydration (connection, outbox, prefs from storage).
function phoneState(): StoreState {
  return {
    ...createServerState(TZ),
    hydrated: true,
    connection: 'offline',
    outbox: [
      {
        mutationId: '0b5a3c2e-8d4f-4a1b-9c7e-2f6d8a1b3c4d',
        payload: { clientMutationId: '0b5a3c2e-8d4f-4a1b-9c7e-2f6d8a1b3c4d', reportingLocation: 'Base', name: 'TEST-1a-ssr' },
        photos: [],
        serverId: null,
        caseNumber: null,
        state: 'pending',
        attempts: 1,
        nextAttemptAt: null,
        lastError: { code: 'network', message: 'offline', status: null },
        operator: { staffName: 'Sam Lee', team: 'Medical', staff: 'Sam Lee · Medical' },
        createdAt: 0,
        source: 'app',
      },
    ],
    prefs: { ...DEFAULT_PREFS, bell: true, theme: 'dark' },
  };
}

function fakeStore(withServerState: boolean): { store: AppStore; start: ReturnType<typeof vi.fn<() => () => void>> } {
  const state = phoneState();
  const server = createServerState(TZ);
  const start = vi.fn<() => () => void>(() => () => {});
  const store: AppStore = {
    getState: () => state,
    subscribe: () => () => {},
    actions: {} as AppStore['actions'],
    start,
    ...(withServerState ? { getServerState: () => server } : {}),
  };
  return { store, start };
}

function Probe() {
  const { connection } = useConnection();
  const outbox = useOutbox();
  const prefs = usePrefs();
  return <p>{`${connection}|${outbox.length}|${prefs.bell ? 'bell' : 'quiet'}|${prefs.theme}`}</p>;
}

describe('createServerState', () => {
  it('is what the server renders: live, nothing queued, unknown session, default prefs', () => {
    const s = createServerState(TZ);
    expect(s).toMatchObject({
      hydrated: false,
      hasData: false,
      outbox: [],
      outboxPrompt: null,
      connection: 'live',
      syncing: false,
      lastSyncAt: null,
      session: { status: 'unknown', staff: null },
      prefs: DEFAULT_PREFS,
      toasts: [],
      snackbar: null,
      updateReady: false,
      offlineReady: false,
      generation: 0,
      eventTimezone: TZ,
    });
    expect(s.confirmed.size).toBe(0);
    expect(s.pending.size).toBe(0);
    expect(s.myIds.size).toBe(0);
  });
});

describe('useStoreSelector on the server', () => {
  it('renders getServerState(), not what the phone knows', () => {
    const { store, start } = fakeStore(true);
    const html = renderToString(
      <StoreContext.Provider value={store}>
        <Probe />
      </StoreContext.Provider>,
    );
    expect(html).toContain('live|0|quiet|auto');
    // Rendering never starts side effects; StoreProvider calls start() from useEffect only.
    expect(start).not.toHaveBeenCalled();
  });

  it('falls back to getState() for a store without getServerState()', () => {
    const html = renderToString(
      <StoreContext.Provider value={fakeStore(false).store}>
        <Probe />
      </StoreContext.Provider>,
    );
    expect(html).toContain('offline|1|bell|dark');
  });
});

describe('StoreProvider on the server', () => {
  it('builds the stub without side effects and renders its server state', async () => {
    const { StoreProvider } = await import('@/lib/client/store');
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const intervals = vi.spyOn(globalThis, 'setInterval');
    try {
      const html = renderToString(
        <StoreProvider eventTimezone={TZ}>
          <Probe />
        </StoreProvider>,
      );
      expect(html).toContain('live|0|quiet|auto');
      expect(timers).not.toHaveBeenCalled();
      expect(intervals).not.toHaveBeenCalled();
    } finally {
      timers.mockRestore();
      intervals.mockRestore();
    }
  });
});
