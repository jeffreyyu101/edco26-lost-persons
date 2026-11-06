// IndexedDB layout of the client (idb-keyval, one object store). Nothing here runs at import time: the
// database is opened by openKv(), which the store calls from start() (server-render invariants).
//
//   cache:<event>:<canonical staff>:rows    RequestSummary[]            the data cache is per staff
//   cache:<event>:<canonical staff>:cursor  {cursor, at}                sync cursor (verbatim) + local time
//   last-staff                              {staffName, team, staff}    whose cache to open on an offline reload
//   myids                                   string[]                    request ids created on this phone
//   outbox:<mutationId>                     StoredJob                   one per create job (per phone)
//   draft                                   StoredDraft                 the new-request draft (per phone)
//   blob:<photoId>                          {full, thumb}               photo bytes, shared by the draft and jobs
//
// Photos are stored as ArrayBuffers, not Blobs (older iOS Safari failed to store Blobs in IndexedDB), and
// under their own keys so frequent draft / checkpoint writes never re-copy megabytes of image data.
//
// Photo bytes and the record that references them (a job or the draft) are committed in ONE transaction
// (setMany), and the garbage collection of unreferenced bytes reads every reference and deletes in ONE
// readwrite transaction (collectBlobs). IndexedDB never runs two readwrite transactions on the same store
// at the same time, across tabs too, so a collection in another tab sees either none of a save or all of
// it: it can never delete bytes whose reference is about to be written.
import { createStore, del, get, getMany, keys, set, setMany, type UseStore } from 'idb-keyval';
import type { OutboxItem, OutboxPhoto, RequestSummary } from '../api-types';
import type { DraftPhoto, RequestDraft } from './store-contract';

export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  /** Writes every entry in one transaction: all of them, or none. */
  setMany(entries: Array<[string, unknown]>): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
  getMany<T>(keys: string[]): Promise<Array<T | undefined>>;
  /**
   * In one readwrite transaction: deletes every `blob:` key that neither the stored draft, nor an unacked
   * photo of a stored job, nor `keep` (references only held in memory) refers to. Resolves to the count.
   */
  collectBlobs(keep: ReadonlySet<string>): Promise<number>;
}

export const EVENT_KEY = 'edco26';
export const DB_NAME = 'lp-client';

/** Opens (lazily creates) the database. Null when IndexedDB is missing or blocked. */
export function openKv(dbName: string = DB_NAME): Kv | null {
  if (typeof indexedDB === 'undefined') return null;
  let store: UseStore;
  try {
    store = createStore(dbName, 'kv');
  } catch {
    return null;
  }
  return {
    get: <T>(key: string) => get<T>(key, store),
    set: (key, value) => set(key, value, store),
    setMany: (entries) => setMany(entries, store),
    del: (key) => del(key, store),
    keys: async () => (await keys(store)).map((k) => String(k)),
    getMany: <T>(ks: string[]) => getMany<T>(ks, store),
    collectBlobs: (keep) => store('readwrite', (os) => collectInTransaction(os, keep)),
  };
}

/** The `blob:` keys a stored draft or job still needs (a job only needs its photos not yet acknowledged). */
export function referencedBlobKeys(key: string, value: unknown): string[] {
  const photos = (value as { photos?: unknown } | null | undefined)?.photos;
  if (!Array.isArray(photos)) return [];
  const isJob = key.startsWith('outbox:');
  const out: string[] = [];
  for (const p of photos as Array<{ photoId?: unknown; acked?: unknown } | null>) {
    if (!p || typeof p.photoId !== 'string') continue;
    if (isJob && p.acked === true) continue;
    out.push(K.blob(p.photoId));
  }
  return out;
}

/**
 * Garbage collection inside one transaction. Only request callbacks are used (no awaits between requests),
 * so the transaction stays active until the deletes are queued; it resolves when it has committed.
 */
function collectInTransaction(os: IDBObjectStore, keep: ReadonlySet<string>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const tx = os.transaction;
    let deleted = 0;
    tx.oncomplete = () => resolve(deleted);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
    const keysRequest = os.getAllKeys();
    keysRequest.onsuccess = () => {
      const all = keysRequest.result.map((k) => String(k));
      const blobKeys = all.filter((k) => k.startsWith('blob:'));
      if (blobKeys.length === 0) return; // nothing to collect: the transaction commits on its own
      const refKeys = all.filter((k) => k === K.draft || k.startsWith('outbox:'));
      const referenced = new Set(keep);
      const sweep = () => {
        for (const k of blobKeys) {
          if (referenced.has(k)) continue;
          os.delete(k);
          deleted += 1;
        }
      };
      let left = refKeys.length;
      if (left === 0) {
        sweep();
        return;
      }
      for (const k of refKeys) {
        const request = os.get(k);
        request.onsuccess = () => {
          for (const b of referencedBlobKeys(k, request.result)) referenced.add(b);
          left -= 1;
          if (left === 0) sweep();
        };
      }
    };
  });
}

export const K = {
  rows: (staffCanon: string) => `cache:${EVENT_KEY}:${staffCanon}:rows`,
  cursor: (staffCanon: string) => `cache:${EVENT_KEY}:${staffCanon}:cursor`,
  lastStaff: 'last-staff',
  myIds: 'myids',
  job: (mutationId: string) => `outbox:${mutationId}`,
  draft: 'draft',
  blob: (photoId: string) => `blob:${photoId}`,
} as const;

export interface StoredCursor {
  cursor: string;
  /** Local epoch ms when it was received (only for the 6 h full-fetch rule, never sent). */
  at: number;
}

export interface StoredStaff {
  staffName: string;
  team: string;
  staff: string;
}

interface StoredBytes {
  b: ArrayBuffer;
  t: string;
}

interface StoredPhotoBlobs {
  full: StoredBytes;
  thumb: StoredBytes;
}

export type StoredJobPhoto = Omit<OutboxPhoto, 'blob' | 'thumbBlob'>;
export type StoredJob = Omit<OutboxItem, 'photos'> & { photos: StoredJobPhoto[] };

export interface StoredDraft {
  clientMutationId: string;
  values: RequestDraft['values'];
  photos: Array<{ photoId: string; width: number; height: number }>;
  photoTiming: RequestDraft['photoTiming'];
  updatedAt: number;
}

async function toBytes(blob: Blob): Promise<StoredBytes> {
  return { b: await blob.arrayBuffer(), t: blob.type || 'image/jpeg' };
}

const fromBytes = (s: StoredBytes): Blob => new Blob([s.b], { type: s.t });

/**
 * The `blob:` entry of one photo, ready for Kv.setMany together with the record that references it. The
 * bytes are read here, before the transaction opens (an await inside it would let it commit early).
 */
export async function photoBlobsEntry(photoId: string, full: Blob, thumb: Blob): Promise<[string, StoredPhotoBlobs]> {
  return [K.blob(photoId), { full: await toBytes(full), thumb: await toBytes(thumb) }];
}

export async function readPhotoBlobs(kv: Kv, photoId: string): Promise<{ full: Blob; thumb: Blob } | null> {
  const v = await kv.get<StoredPhotoBlobs>(K.blob(photoId));
  if (!v?.full || !v.thumb) return null;
  return { full: fromBytes(v.full), thumb: fromBytes(v.thumb) };
}

export function jobToStored(job: OutboxItem): StoredJob {
  return {
    ...job,
    // 'sending' is in-memory only: a job read back after a crash or reload is simply pending again.
    state: job.state === 'sending' ? 'pending' : job.state,
    photos: job.photos.map(({ blob: _b, thumbBlob: _t, ...rest }) => rest),
  };
}

/** Reads every job with its photo bytes. Jobs whose bytes are gone keep their photos as already handled. */
export async function readJobs(kv: Kv): Promise<OutboxItem[]> {
  const jobKeys = (await kv.keys()).filter((k) => k.startsWith('outbox:'));
  if (jobKeys.length === 0) return [];
  const stored = await kv.getMany<StoredJob>(jobKeys);
  const out: OutboxItem[] = [];
  for (const job of stored) {
    if (!job || typeof job !== 'object' || typeof job.mutationId !== 'string' || !job.payload) continue;
    const photos: OutboxPhoto[] = [];
    for (const p of job.photos ?? []) {
      const blobs = p.acked ? null : await readPhotoBlobs(kv, p.photoId);
      if (!p.acked && !blobs) {
        // The bytes are gone (storage evicted): nothing left to upload for this photo.
        photos.push({ ...p, acked: true, rejected: true, blob: new Blob([]), thumbBlob: new Blob([]) });
        continue;
      }
      photos.push({ ...p, blob: blobs?.full ?? new Blob([]), thumbBlob: blobs?.thumb ?? new Blob([]) });
    }
    out.push({ ...job, state: job.state === 'sending' ? 'pending' : job.state, photos });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export async function readDraft(kv: Kv): Promise<RequestDraft | null> {
  const d = await kv.get<StoredDraft>(K.draft);
  if (!d || typeof d.clientMutationId !== 'string' || !d.values) return null;
  const photos: DraftPhoto[] = [];
  for (const p of d.photos ?? []) {
    const blobs = await readPhotoBlobs(kv, p.photoId);
    if (blobs) photos.push({ photoId: p.photoId, blob: blobs.full, thumbBlob: blobs.thumb, width: p.width, height: p.height });
  }
  return { clientMutationId: d.clientMutationId, values: d.values, photos, photoTiming: d.photoTiming === 'older' ? 'older' : 'today', updatedAt: d.updatedAt };
}

export function draftToStored(d: RequestDraft): StoredDraft {
  return {
    clientMutationId: d.clientMutationId,
    values: d.values,
    photos: d.photos.map((p) => ({ photoId: p.photoId, width: p.width, height: p.height })),
    photoTiming: d.photoTiming,
    updatedAt: d.updatedAt,
  };
}

export async function readRows(kv: Kv, staffCanon: string): Promise<RequestSummary[] | null> {
  const rows = await kv.get<RequestSummary[]>(K.rows(staffCanon));
  return Array.isArray(rows) ? rows : null;
}
