// A fake browser environment for the real store (lib/client/store-core.ts): window/document listeners,
// online/visibility switches, localStorage/sessionStorage, redirects, BroadcastChannel (Node's own, per
// test name) and a fresh fake-indexeddb database per test.
import 'fake-indexeddb/auto';
import { vi } from 'vitest';
import { openKv } from '@/lib/client/persist';
import type { StoreEnv } from '@/lib/client/store-core';
import type { FakeServer } from './fake-server';

export class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

let dbSeq = 0;

export interface FakeEnv {
  env: StoreEnv;
  server: FakeServer;
  redirects: string[];
  local: MemoryStorage;
  session: MemoryStorage;
  setOnline(v: boolean): void;
  setVisible(v: boolean): void;
  fire(target: 'window' | 'document', type: string): void;
  listenerCount(): number;
  dbName: string;
}

export interface EnvOptions {
  /** Share a database / channel / localStorage with another fake tab. */
  dbName?: string;
  channelName?: string;
  local?: MemoryStorage;
  path?: string;
}

export function fakeEnv(server: FakeServer, opts: EnvOptions = {}): FakeEnv {
  dbSeq += 1;
  const dbName = opts.dbName ?? `lp-test-${process.pid}-${dbSeq}-${Math.random().toString(36).slice(2)}`;
  const channelName = opts.channelName ?? `${dbName}-channel`;
  const listeners = new Map<string, Set<(e: Event) => void>>();
  let online = true;
  let visible = true;
  const redirects: string[] = [];
  const local = opts.local ?? new MemoryStorage();
  const session = new MemoryStorage();
  const env: StoreEnv = {
    fetch: server.fetch,
    online: () => online,
    visible: () => visible,
    on(target, type, handler) {
      const key = `${target}:${type}`;
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(handler);
      return () => set.delete(handler);
    },
    locks: null,
    channel: (name) => new BroadcastChannel(`${channelName}:${name}`) as unknown as ReturnType<StoreEnv['channel']>,
    openKv: () => openKv(dbName),
    localStorage: () => local,
    sessionStorage: () => session,
    redirect: (url) => {
      redirects.push(url);
    },
    location: () => opts.path ?? '/?view=pending',
    serviceWorker: () => null,
  };
  return {
    env,
    server,
    redirects,
    local,
    session,
    dbName,
    setOnline: (v) => {
      online = v;
    },
    setVisible: (v) => {
      visible = v;
    },
    fire(target, type) {
      for (const h of [...(listeners.get(`${target}:${type}`) ?? [])]) h(new Event(type));
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

/** Real macrotask turns (fake-indexeddb runs on setImmediate, which the tests never fake). */
export async function settle(turns = 60): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((r) => setImmediate(r));
}

/** Fake the clocks the store uses, never setImmediate (fake-indexeddb needs it). */
export function useStoreTimers(start = Date.parse('2026-11-07T03:00:00Z')): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: start });
}

/** Advance fake time and let IndexedDB / promises catch up. */
export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}
