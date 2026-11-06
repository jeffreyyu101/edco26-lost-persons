// Boots the real store against the fake API (fake-indexeddb, fake timers with no poll jitter).
import { afterEach, beforeEach, vi } from 'vitest';
import { createAppStore, type StoreEnv } from '@/lib/client/store-core';
import type { DraftPhoto } from '@/lib/client/store-contract';
import { EMPTY_FORM_VALUES, type RequestFormValues } from '@/lib/client/form-values';
import { advance, fakeEnv, settle, useStoreTimers, type EnvOptions } from './env';
import type { FakeServer } from './fake-server';

export const TZ = 'America/New_York';
const stops: Array<() => void> = [];

export function installStoreHooks(): void {
  beforeEach(() => {
    useStoreTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await settle(10);
  });
}

export function boot(server: FakeServer, opts: EnvOptions = {}, tweak?: (env: StoreEnv) => void) {
  const fe = fakeEnv(server, opts);
  tweak?.(fe.env);
  const store = createAppStore({ eventTimezone: TZ, env: () => fe.env });
  const stop = store.start?.() ?? (() => {});
  stops.push(stop);
  return { store, fe, stop, s: () => store.getState(), a: store.actions };
}

/** Let boot (IndexedDB) finish and the first poll run. */
export async function ready(): Promise<void> {
  await settle();
  await advance(0);
  await advance(50);
}

/** Resolve a promise while letting IndexedDB and fake timers move (up to `ms` of fake time). */
export async function finish<T>(p: Promise<T>, ms = 0): Promise<T> {
  let done = false;
  let value: T | undefined;
  let error: unknown;
  let failed = false;
  void p.then(
    (v) => {
      done = true;
      value = v;
    },
    (e: unknown) => {
      done = true;
      failed = true;
      error = e;
    },
  );
  for (let i = 0; i < 40 && !done; i += 1) await settle(20);
  if (!done && ms > 0) await advance(ms);
  for (let i = 0; i < 40 && !done; i += 1) await settle(20);
  if (!done) throw new Error('promise did not settle');
  if (failed) throw error;
  return value as T;
}

export function values(patch: Partial<RequestFormValues> = {}): RequestFormValues {
  return { ...EMPTY_FORM_VALUES, name: 'P.G.', age: '30', gender: 'Male', reportingLocation: 'FA 3 – Kinetic', clothing: 'Green tee', ...patch };
}

export function photo(id: string): DraftPhoto {
  return { photoId: id, blob: new Blob([new Uint8Array([0xff, 0xd8, 1, 2, 3])], { type: 'image/jpeg' }), thumbBlob: new Blob([new Uint8Array([0xff, 0xd8, 9])], { type: 'image/jpeg' }), width: 4, height: 3 };
}

/** A gate: the override returns `wait()` and the test calls `open()`. */
export function gate() {
  let release: (() => void) | null = null;
  const promise = new Promise<undefined>((r) => {
    release = () => r(undefined);
  });
  return { wait: () => promise, open: () => (release as unknown as () => void)() };
}
