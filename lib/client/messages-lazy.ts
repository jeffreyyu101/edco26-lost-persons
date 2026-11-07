// The messages engine (messages-core.ts), loaded after the store starts so it stays out of the first-load JS
// (spec §7 Performance, v2.2 A25: `/` first load ≤ 230 KB, its own code ≤ 40 KB). The store holds this
// stand-in from the start, with the engine's exact API:
//   * before the engine is there, a thread asked open is remembered (and opened once it loads), the snapshot
//     is empty, and sign-out counts the queued jobs straight from IndexedDB (unsentNow), so nothing on the
//     boot or sign-out path ever waits for this code to download;
//   * every other call waits for the engine and then runs, in the order it was made;
//   * hydrate() asked before the engine loaded runs as soon as it loads, whichever call loads it (a failed
//     boot load must not leave saved jobs unread and unsent), then kicks the outbox;
//   * a failed load (offline before the chunk was cached) is tried again on the next call; a call that
//     needs the engine then says so ("Messages need a connection") rather than dropping anything silently.
import type { MessagingEngine, MessagingHost, MessagingSnapshot } from './messages-core';

export type CreateMessaging = (host: MessagingHost) => MessagingEngine;

export interface LazyMessagingEngine extends MessagingEngine {
  /** The engine, loading it first if needed (rejects when the chunk can't be loaded). */
  ready(): Promise<MessagingEngine>;
  /**
   * Unsent jobs on this phone, for sign-out: the engine's count once it has read them; without the engine,
   * the saved `mjob:` keys in IndexedDB. Never waits for the engine's code.
   */
  unsentNow(): Promise<number>;
}

const EMPTY_SNAPSHOT: MessagingSnapshot = { threads: new Map(), jobs: [] };
const LOAD_FAILED = 'Messages need a connection';

export const loadMessagingEngine = (): Promise<CreateMessaging> => import('./messages-core').then((m) => m.createMessaging);

export function createLazyMessaging(host: MessagingHost, load: () => Promise<CreateMessaging> = loadMessagingEngine): LazyMessagingEngine {
  let engine: MessagingEngine | null = null;
  let loading: Promise<MessagingEngine> | null = null;
  let running = false;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of [...listeners]) l();
  };
  /** Threads asked open before the engine loaded: token → request id. */
  const pendingOpen = new Map<number, string>();
  let openSeq = 0;

  /** hydrate() was asked for and has not run on the engine yet. */
  let hydrateDue = false;
  let hydrating: Promise<void> | null = null;
  /** Reads the saved jobs once asked (then kicks the outbox: they may be due); the same run for every caller. */
  const hydrateEngine = (e: MessagingEngine): Promise<void> => {
    if (hydrateDue) {
      hydrateDue = false;
      hydrating = e.hydrate().then(
        () => {
          if (running) e.kick();
        },
        () => undefined,
      );
    }
    return hydrating ?? Promise.resolve();
  };

  const ready = (): Promise<MessagingEngine> => {
    if (engine) return Promise.resolve(engine);
    loading ??= load().then(
      (create) => {
        const e = engine ?? create(host);
        if (!engine) {
          engine = e;
          e.subscribe(emit);
          if (running) e.start();
          emit();
          // Whichever call loaded it: jobs saved before a failed boot load are read now, not never.
          void hydrateEngine(e);
        }
        return e;
      },
      (error: unknown) => {
        loading = null;
        throw error;
      },
    );
    return loading;
  };

  const later = (run: (e: MessagingEngine) => void) => {
    if (engine) run(engine);
    else void ready().then(run, () => undefined);
  };

  const failed = () => {
    host.showToast({ tone: 'amber', icon: 'cloud-off', title: LOAD_FAILED, durationMs: 4_000 });
  };

  return {
    ready,
    getSnapshot: () => engine?.getSnapshot() ?? EMPTY_SNAPSHOT,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open(requestId) {
      if (engine) return engine.open(requestId);
      const token = (openSeq += 1);
      pendingOpen.set(token, requestId);
      let close: (() => void) | null = null;
      let closed = false;
      void ready().then(
        (e) => {
          pendingOpen.delete(token);
          if (!closed) close = e.open(requestId);
        },
        () => undefined,
      );
      return () => {
        closed = true;
        pendingOpen.delete(token);
        close?.();
      };
    },
    isOpen: (requestId) => (engine ? engine.isOpen(requestId) : [...pendingOpen.values()].includes(requestId)),
    refresh: (requestId) => later((e) => e.refresh(requestId)),
    async loadEarlier(requestId) {
      const e = await ready().catch(() => null);
      if (e) await e.loadEarlier(requestId);
      else failed();
    },
    async send(requestId, body) {
      const e = await ready().catch(() => null);
      if (e) return e.send(requestId, body);
      failed();
      return false;
    },
    retry: (jobId) => later((e) => e.retry(jobId)),
    async discard(jobId) {
      const e = await ready().catch(() => null);
      if (e) await e.discard(jobId);
    },
    async unsend(requestId, messageId) {
      const e = await ready().catch(() => null);
      if (e) return e.unsend(requestId, messageId);
      failed();
      return false;
    },
    async setEnroute(requestId, action, etaMinutes, opts) {
      const e = await ready().catch(() => null);
      if (e) await e.setEnroute(requestId, action, etaMinutes, opts);
      else failed();
    },
    async cancelEnroute(requestId, previous) {
      const e = await ready().catch(() => null);
      if (e) await e.cancelEnroute(requestId, previous);
      else failed();
    },
    markRead: (requestId) => later((e) => e.markRead(requestId)),
    unsentCount: () => engine?.unsentCount() ?? 0,
    async unsentNow() {
      if (engine) {
        await hydrateEngine(engine);
        return engine.unsentCount();
      }
      const n = await host.enqueue(async (store) => (await store.keys()).filter((k) => k.startsWith('mjob:')).length);
      return typeof n === 'number' ? n : 0;
    },

    start() {
      running = true;
      if (engine) engine.start();
      else void ready().catch(() => undefined);
    },
    stop() {
      running = false;
      engine?.stop();
    },
    async hydrate() {
      hydrateDue = true;
      const e = await ready().catch(() => null);
      if (e) await hydrateEngine(e);
    },
    async reload() {
      const e = await ready().catch(() => null);
      if (e) await e.reload();
    },
    kick: () => later((e) => e.kick()),
    async clear(discardJobs) {
      if (engine) {
        await engine.clear(discardJobs);
        return;
      }
      // Without the engine (never waited for: sign-out must not hang on a download) there are no threads;
      // queued jobs still go when asked (their keys, as the engine would). An engine that loads later reads
      // IndexedDB through the same queue, after this, so it starts without them.
      if (discardJobs) {
        await host.enqueue(async (store) => {
          for (const k of await store.keys()) if (k.startsWith('mjob:')) await store.del(k);
        });
      }
    },
  };
}
