// The messages engine loads after the store starts (lib/client/messages-lazy.ts, spec §7 A25 first-load
// budget). Until it is there nothing is lost: a thread asked open opens once it loads, calls run in order,
// and a failed load says so and is tried again on the next call.
import { describe, expect, it, vi } from 'vitest';
import type { MessagingEngine, MessagingHost, MessagingSnapshot } from '@/lib/client/messages-core';
import { createLazyMessaging, type CreateMessaging } from '@/lib/client/messages-lazy';

function fakeEngine() {
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  const opened = new Map<string, number>();
  let snapshot: MessagingSnapshot = { threads: new Map(), jobs: [] };
  const engine: MessagingEngine = {
    getSnapshot: () => snapshot,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    open(id) {
      calls.push(`open ${id}`);
      opened.set(id, (opened.get(id) ?? 0) + 1);
      return () => {
        calls.push(`close ${id}`);
        opened.set(id, (opened.get(id) ?? 1) - 1);
      };
    },
    isOpen: (id) => (opened.get(id) ?? 0) > 0,
    refresh: (id) => void calls.push(`refresh ${id}`),
    loadEarlier: async (id) => void calls.push(`earlier ${id}`),
    send: async (id, body) => {
      calls.push(`send ${id} ${body}`);
      return true;
    },
    retry: (id) => void calls.push(`retry ${id}`),
    discard: async (id) => void calls.push(`discard ${id}`),
    unsend: async () => true,
    setEnroute: async (id, action) => void calls.push(`enroute ${id} ${action}`),
    cancelEnroute: async (id) => void calls.push(`cancel ${id}`),
    markRead: (id) => void calls.push(`read ${id}`),
    unsentCount: () => 2,
    start: () => void calls.push('start'),
    stop: () => void calls.push('stop'),
    hydrate: async () => void calls.push('hydrate'),
    reload: async () => void calls.push('reload'),
    kick: () => void calls.push('kick'),
    clear: async (d) => void calls.push(`clear ${d}`),
  };
  const change = (next: MessagingSnapshot) => {
    snapshot = next;
    for (const l of listeners) l();
  };
  return { engine, calls, change };
}

function host(keys: string[] = []) {
  const toasts: string[] = [];
  const h = {
    showToast: (t: { title: string }) => {
      toasts.push(t.title);
      return 'id';
    },
    enqueue: async <T>(op: (store: { keys(): Promise<string[]>; del(k: string): Promise<void> }) => Promise<T>) =>
      op({
        keys: async () => [...keys],
        del: async (k: string) => {
          keys.splice(keys.indexOf(k), 1);
        },
      }),
  } as unknown as MessagingHost;
  return { h, toasts, keys };
}

/** A loader the test releases. */
function gatedLoader(create: CreateMessaging) {
  let release!: () => void;
  let fail!: () => void;
  const load = vi.fn(
    () =>
      new Promise<CreateMessaging>((resolve, reject) => {
        release = () => resolve(create);
        fail = () => reject(new Error('chunk failed'));
      }),
  );
  return { load, release: () => release(), fail: () => fail() };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('the lazily loaded messages engine', () => {
  it('starts loading at start(); a thread opened before it loaded opens once, and closes with its view', async () => {
    const f = fakeEngine();
    const g = gatedLoader(() => f.engine);
    const m = createLazyMessaging(host().h, g.load);
    expect(g.load).not.toHaveBeenCalled();
    m.start();
    expect(g.load).toHaveBeenCalledTimes(1);
    const close = m.open('r1');
    expect(m.isOpen('r1')).toBe(true);
    expect(m.getSnapshot()).toEqual({ threads: new Map(), jobs: [] });
    expect(m.unsentCount()).toBe(0);
    m.kick();
    m.refresh('r1');
    g.release();
    await tick();
    expect(f.calls).toEqual(['start', 'open r1', 'kick', 'refresh r1']);
    expect(m.isOpen('r1')).toBe(true);
    expect(m.unsentCount()).toBe(2);
    close();
    expect(m.isOpen('r1')).toBe(false);
    // A view that closed before the engine loaded never opens.
    const g2 = gatedLoader(() => fakeEngine().engine);
    const m2 = createLazyMessaging(host().h, g2.load);
    const close2 = m2.open('r2');
    close2();
    expect(m2.isOpen('r2')).toBe(false);
  });

  it("forwards the engine's changes to subscribers, after one change when it loads", async () => {
    const f = fakeEngine();
    const g = gatedLoader(() => f.engine);
    const m = createLazyMessaging(host().h, g.load);
    const seen: MessagingSnapshot[] = [];
    m.subscribe(() => seen.push(m.getSnapshot()));
    void m.ready();
    g.release();
    await tick();
    expect(seen).toHaveLength(1);
    const next = { threads: new Map(), jobs: [] };
    f.change(next);
    expect(seen[1]).toBe(next);
  });

  it('a send waits for the engine; a failed load says so, sends nothing, and is tried again next time', async () => {
    const f = fakeEngine();
    const g = gatedLoader(() => f.engine);
    const { h, toasts } = host();
    const m = createLazyMessaging(h, g.load);
    const first = m.send('r1', 'Hi');
    g.fail();
    expect(await first).toBe(false);
    expect(toasts).toEqual(['Messages need a connection']);
    const second = m.send('r1', 'Hi again');
    expect(g.load).toHaveBeenCalledTimes(2);
    g.release();
    expect(await second).toBe(true);
    expect(f.calls).toEqual(['send r1 Hi again']);
  });

  it('sign-out without the engine still discards the queued jobs it was asked to', async () => {
    const g = gatedLoader(() => fakeEngine().engine);
    const { h, keys } = host(['mjob:a', 'cache:x', 'mjob:b']);
    const m = createLazyMessaging(h, g.load);
    const done = m.clear(true);
    g.fail();
    await done;
    expect(keys).toEqual(['cache:x']);
  });
});
