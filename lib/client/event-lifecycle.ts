// (Events) What happens to an event's data on this phone when the event changes under it: practice → live drops the
// event's cache (practice rows a delta sync would never remove) and its practice creates; an ended event's cache,
// outbox, queued messages and draft go. Loaded with import() by the store (lib/client/store-core.ts) when a session
// is confirmed or an event ends, so the first load of `/` does not carry it. The store passes what it owns (the host).
import type { OutboxItem } from '../api-types';
import { K, NO_EVENT, type Kv, type StoredDraft, type StoredEventMeta, type StoredJob } from './persist';

export { rememberEnded } from './ended';

export interface LifecycleHost {
  kv(): Kv | null;
  /** The store's serialised IndexedDB queue. */
  enqueue<T>(op: (store: Kv) => Promise<T>): Promise<T | undefined>;
  /** The event whose cache is loaded, and the one this tab works. */
  cacheEvent(): string | null;
  eventKey(): string;
  /** Empties the screen's rows and forgets the cursor (the loaded event's cache is going). */
  clearLoaded(): void;
  outbox(): readonly OutboxItem[];
  setJobs(jobs: OutboxItem[]): void;
  /** After a drop: unreferenced photo bytes, the other tabs, the operator prompt. */
  afterDrop(): Promise<void>;
}

/**
 * The event went live since this phone cached it: its cache goes, for every staff, and so do the creates queued while
 * it was in practice. Remembers when the cache's event went live (K.meta). True when it dropped the cache.
 */
export async function checkWentLive(host: LifecycleHost, eventId: string, wentLiveAt: string | null): Promise<boolean> {
  if (!host.kv() || eventId === NO_EVENT) return false;
  const meta = await host.enqueue((store) => store.get<StoredEventMeta>(K.meta(eventId)));
  const changed = !!meta && (meta.wentLiveAt ?? null) !== wentLiveAt;
  if (changed) await dropEventData(host, eventId, { practiceOnly: wentLiveAt });
  if (!meta || changed) {
    const record: StoredEventMeta = { wentLiveAt };
    await host.enqueue((store) => store.set(K.meta(eventId), record));
  }
  return changed;
}

/**
 * Deletes one event's data on this phone: its cache (every staff's rows, cursors, threads), and its queued creates,
 * messages and draft. `practiceOnly` (go-live): only the creates queued in practice (stamped with an earlier
 * wentLiveAt) go; the rest stays. When it is the loaded event, the screen empties too.
 */
export async function dropEventData(host: LifecycleHost, eventId: string, opts: { practiceOnly?: string | null } = {}): Promise<void> {
  const practice = opts.practiceOnly !== undefined;
  const dropsJob = (job: Pick<StoredJob, 'eventId' | 'wentLiveAt'> | null | undefined) =>
    !!job && (job.eventId ?? NO_EVENT) === eventId && (!practice || (job.wentLiveAt !== undefined && (job.wentLiveAt ?? null) !== opts.practiceOnly));
  if (host.cacheEvent() === eventId) host.clearLoaded();
  if (host.eventKey() === eventId) {
    const left = host.outbox().filter((j) => !dropsJob(j));
    if (left.length !== host.outbox().length) host.setJobs(left);
  }
  await host.enqueue(async (store) => {
    for (const k of await store.keys()) {
      if (k.startsWith(K.eventCache(eventId))) await store.del(k);
      else if (k.startsWith('outbox:') && dropsJob(await store.get<StoredJob>(k))) await store.del(k);
      else if (!practice && k.startsWith('mjob:') && ((await store.get<{ eventId?: string }>(k))?.eventId ?? NO_EVENT) === eventId) await store.del(k);
      else if (!practice && k === K.draft && ((await store.get<StoredDraft>(k))?.eventId ?? NO_EVENT) === eventId) await store.del(k);
    }
  });
  await host.afterDrop();
}
