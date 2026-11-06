// Photo bytes and the garbage collection of unreferenced ones, across two tabs on one phone (regression).
// The tabs share one IndexedDB database; each serialises only its own writes. A wrapper around a tab's
// database pauses it at the moment the race needs (after photo bytes are written / when a collection
// starts), so the interleaving that happens between real tabs is reproduced on purpose. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { K, openKv, readJobs, type Kv } from '@/lib/client/persist';
import type { StoreEnv } from '@/lib/client/store-core';
import { settle } from './helpers/env';
import { boot, finish, gate, installStoreHooks, photo, ready, values } from './helpers/boot';
import { FakeServer } from './helpers/fake-server';

installStoreHooks();

const CMID = (n: number) => `9c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PHOTO = (n: number) => `e0000000-0000-4000-8000-0000000009${String(n).padStart(2, '0')}`;

interface Hooks {
  /** After a write that stored photo bytes has committed. */
  afterBlobWrite?: () => Promise<void>;
  /** A garbage collection started (before it decides anything). */
  gcStarted?: () => Promise<void>;
}

/**
 * Delegates to the real database. `keys()` is where a collection used to start (it listed the keys, then
 * read the references in later transactions); `collectBlobs()` is the one-transaction collection.
 */
function pausing(kv: Kv, hooks: Hooks): Kv {
  return {
    get: <T>(key: string) => kv.get<T>(key),
    async set(key, value) {
      await kv.set(key, value);
      if (key.startsWith('blob:')) await hooks.afterBlobWrite?.();
    },
    async setMany(entries) {
      await kv.setMany(entries);
      if (entries.some(([key]) => key.startsWith('blob:'))) await hooks.afterBlobWrite?.();
    },
    del: (key) => kv.del(key),
    async keys() {
      const all = await kv.keys();
      await hooks.gcStarted?.();
      return all;
    },
    getMany: <T>(ks: string[]) => kv.getMany<T>(ks),
    async collectBlobs(keep) {
      await hooks.gcStarted?.();
      return kv.collectBlobs(keep);
    },
  };
}

const withHooks = (hooks: Hooks) => (env: StoreEnv) => {
  const open = env.openKv;
  env.openKv = () => {
    const kv = open();
    return kv ? pausing(kv, hooks) : kv;
  };
};

/** Pauses once, the first time it is armed and reached. */
function once() {
  const g = gate();
  let armed = false;
  let held = false;
  return {
    arm: () => {
      armed = true;
    },
    get held() {
      return held;
    },
    open: g.open,
    hook: async () => {
      if (!armed || held) return;
      held = true;
      await g.wait();
    },
  };
}

async function storedJob(dbName: string, mutationId: string) {
  const kv = openKv(dbName);
  if (!kv) throw new Error('no database');
  return (await readJobs(kv)).find((j) => j.mutationId === mutationId);
}

describe('photo bytes survive a garbage collection in another tab (regression)', () => {
  it('a collection while this tab is saving a job with photos never deletes them', async () => {
    const server = new FakeServer([]);
    const pause = once();
    const one = boot(server, {}, withHooks({ afterBlobWrite: pause.hook }));
    await ready();
    const two = boot(server, { dbName: one.fe.dbName, channelName: `${one.fe.dbName}-channel` });
    await ready();
    // Both offline: the job stays queued (no tab sends it), so only the stored copy matters.
    one.fe.setOnline(false);
    two.fe.setOnline(false);
    pause.arm();
    const saving = one.a.create({ values: values(), clientMutationId: CMID(1), photos: [photo(PHOTO(1)), photo(PHOTO(2))], photoTiming: 'today' });
    await settle(80);
    expect(pause.held).toBe(true); // photo bytes written, the save not finished
    await finish(two.a.draft.clear()); // clearing a draft collects unreferenced bytes
    pause.open();
    expect((await finish(saving)).outcome).toBe('queued');
    const job = await storedJob(one.fe.dbName, CMID(1));
    expect(job?.photos.map((p) => ({ id: p.photoId, rejected: !!p.rejected, acked: p.acked }))).toEqual([
      { id: PHOTO(1), rejected: false, acked: false },
      { id: PHOTO(2), rejected: false, acked: false },
    ]);
    expect(await job?.photos[1]?.blob.arrayBuffer()).toEqual(await photo('x').blob.arrayBuffer());
  });

  it('a collection that started before a draft became a job keeps the job’s photo', async () => {
    const server = new FakeServer([]);
    const one = boot(server);
    await ready();
    const pause = once();
    // Same database, another channel: tab two never loads the job into memory (only the store has it).
    const two = boot(server, { dbName: one.fe.dbName, channelName: 'unrelated' }, withHooks({ gcStarted: pause.hook }));
    await ready();
    one.fe.setOnline(false);
    two.fe.setOnline(false);
    one.a.draft.save({ clientMutationId: CMID(2), values: values(), photos: [photo(PHOTO(3))], photoTiming: 'today', updatedAt: 1 });
    await settle(80);
    expect((await openKv(one.fe.dbName)?.keys()) ?? []).toContain(K.blob(PHOTO(3)));
    pause.arm();
    const collecting = two.a.outbox.discard(CMID(99)); // finishing or discarding a job collects too
    await settle(80);
    expect(pause.held).toBe(true);
    // Meanwhile tab one sends the draft: it becomes a job (same photo) and the draft is cleared.
    expect((await finish(one.a.create({ values: values(), clientMutationId: CMID(2), photos: [photo(PHOTO(3))], photoTiming: 'today' }))).outcome).toBe('queued');
    await settle(80);
    expect(await openKv(one.fe.dbName)?.get(K.draft)).toBeUndefined();
    pause.open();
    await finish(collecting);
    const job = await storedJob(one.fe.dbName, CMID(2));
    expect(job?.photos.map((p) => !!p.rejected)).toEqual([false]);
  });
});

describe('collectBlobs', () => {
  it('keeps bytes the draft, an unacked job photo or `keep` refer to, and deletes the rest in one go', async () => {
    const kv = openKv(`lp-gc-${Math.random().toString(36).slice(2)}`);
    if (!kv) throw new Error('no database');
    const bytes = { full: { b: new ArrayBuffer(1), t: 'image/jpeg' }, thumb: { b: new ArrayBuffer(1), t: 'image/jpeg' } };
    await kv.setMany([
      [K.blob('draft-photo'), bytes],
      [K.blob('job-pending'), bytes],
      [K.blob('job-acked'), bytes],
      [K.blob('in-memory'), bytes],
      [K.blob('orphan'), bytes],
      [K.draft, { clientMutationId: CMID(3), values: {}, photos: [{ photoId: 'draft-photo', width: 1, height: 1 }], photoTiming: 'today', updatedAt: 1 }],
      [K.job(CMID(4)), { mutationId: CMID(4), photos: [{ photoId: 'job-pending', acked: false }, { photoId: 'job-acked', acked: true }] }],
      ['cache:edco26:x:rows', []],
    ]);
    expect(await kv.collectBlobs(new Set([K.blob('in-memory')]))).toBe(2);
    const left = (await kv.keys()).filter((k) => k.startsWith('blob:')).sort();
    expect(left).toEqual([K.blob('draft-photo'), K.blob('in-memory'), K.blob('job-pending')]);
    expect(await kv.collectBlobs(new Set())).toBe(1); // nothing else changed: only the in-memory one goes
    expect(await kv.get('cache:edco26:x:rows')).toEqual([]);
  });
});
