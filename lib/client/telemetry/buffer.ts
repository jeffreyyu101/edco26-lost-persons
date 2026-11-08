// Buffering (design §4.4): discrete events in a 500-event memory ring (the oldest dropped), aggregates in maps that
// become one event per key when a batch is built, and built batches waiting for a resend in a 500-event IndexedDB ring
// of their own (`lp-tel` / `q`, a separate database from the store's `lp-client`, so it never queues behind the
// store's transactions). Every event is cleaned to the ingest schema here, so the server never has to drop one.
import { CRUMB_RE, ENUM_RE, PROP_KEYS, TEL_IDB, TEL_LIMITS, TOKEN_RE, VIEWS, type EventName, type TelView } from '../../telemetry';
import type { Trail } from './crumbs';

export type PropValue = number | boolean | string | number[];
export type Props = Record<string, PropValue>;

export interface TelEvent {
  n: EventName;
  at: number;
  v?: TelView;
  a?: string;
  c?: string;
  ms?: number;
  k?: number;
  ok?: boolean;
  p?: Props;
  tr?: Trail;
}

const PROP_SET: ReadonlySet<string> = new Set(PROP_KEYS);
const VIEW_SET: ReadonlySet<string> = new Set(VIEWS);
const DAY_MS = 86_400_000;

const clampInt = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : undefined;

/** The event as the ingest schema accepts it: bad tokens, values and keys dropped, numbers clamped. Null if unusable. */
export function cleanEvent(e: TelEvent): TelEvent | null {
  if (!Number.isFinite(e.at)) return null;
  const out: TelEvent = { n: e.n, at: Math.round(e.at) };
  if (e.v !== undefined) out.v = VIEW_SET.has(e.v) ? e.v : 'unknown';
  if (typeof e.a === 'string' && TOKEN_RE.test(e.a)) out.a = e.a;
  if (typeof e.c === 'string' && TOKEN_RE.test(e.c)) out.c = e.c;
  const ms = clampInt(e.ms, 0, DAY_MS);
  if (ms !== undefined) out.ms = ms;
  const k = clampInt(e.k, 0, 100_000);
  if (k !== undefined) out.k = k;
  if (typeof e.ok === 'boolean') out.ok = e.ok;
  if (e.p) {
    const p: Props = {};
    let n = 0;
    for (const [key, v] of Object.entries(e.p)) {
      if (n >= TEL_LIMITS.props || !PROP_SET.has(key) || v === undefined || v === null) continue;
      if (key === 'd') {
        if (Array.isArray(v)) {
          const d = v.slice(0, TEL_LIMITS.durations).map((x) => clampInt(x, 0, DAY_MS) ?? 0);
          if (d.length) {
            p.d = d;
            n += 1;
          }
        }
        continue;
      }
      if (typeof v === 'boolean') p[key] = v;
      else if (typeof v === 'number' && Number.isFinite(v)) p[key] = Math.max(-2_147_483_647, Math.min(2_147_483_647, Math.round(v)));
      else if (typeof v === 'string' && ENUM_RE.test(v)) p[key] = v;
      else continue;
      n += 1;
    }
    if (n > 0) out.p = p;
  }
  if (e.tr && e.tr.length) out.tr = e.tr.slice(-TEL_LIMITS.trail).filter(([dt, c]) => Number.isInteger(dt) && dt <= 0 && dt >= -DAY_MS && CRUMB_RE.test(c));
  return out;
}

export class EventBuffer {
  private ring: TelEvent[] = [];
  private aggs = new Map<string, TelEvent>();
  /** Error fingerprints in the ring: a repeat counts on the first one (k). */
  private errors = new Map<string, TelEvent>();
  dropped = 0;

  constructor(private readonly cap: number = TEL_LIMITS.memory) {}

  push(e: TelEvent): void {
    const clean = cleanEvent(e);
    if (!clean) return;
    this.ring.push(clean);
    if (this.ring.length > this.cap) {
      const old = this.ring.shift();
      this.dropped += 1;
      if (old?.n === 'error') for (const [fp, ev] of this.errors) if (ev === old) this.errors.delete(fp);
    }
  }

  /** An error: the first of a fingerprint is kept (with its trail), repeats count on it until the next send. */
  pushError(fp: string, e: TelEvent): void {
    const seen = this.errors.get(fp);
    if (seen) {
      seen.k = Math.min(100_000, (seen.k ?? 1) + 1);
      return;
    }
    const clean = cleanEvent({ ...e, k: 1 });
    if (!clean) return;
    this.errors.set(fp, clean);
    this.ring.push(clean);
    if (this.ring.length > this.cap) this.ring.shift();
  }

  /** The aggregate row for `key` (created by `make` the first time), updated in place. */
  agg(key: string, make: () => TelEvent, update: (e: TelEvent) => void): void {
    let e = this.aggs.get(key);
    if (!e) {
      e = make();
      this.aggs.set(key, e);
    }
    update(e);
  }

  get discrete(): number {
    return this.ring.length;
  }

  get aggregates(): number {
    return this.aggs.size;
  }

  /** Takes up to `maxEvents` events and `maxBytes` of JSON: discrete events first, then (when asked) the aggregates. */
  take(maxEvents: number = TEL_LIMITS.batchEvents, maxBytes: number = TEL_LIMITS.batchBytes - 1_024, withAggregates = true): TelEvent[] {
    const out: TelEvent[] = [];
    let bytes = 0;
    const fits = (e: TelEvent) => {
      const size = JSON.stringify(e).length + 1;
      if (out.length >= maxEvents || bytes + size > maxBytes) return false;
      bytes += size;
      out.push(e);
      return true;
    };
    while (this.ring.length) {
      const e = this.ring[0] as TelEvent;
      if (!fits(e)) break;
      this.ring.shift();
    }
    this.errors.clear();
    if (withAggregates) {
      for (const [key, e] of this.aggs) {
        const clean = cleanEvent(e);
        if (!clean) {
          this.aggs.delete(key);
          continue;
        }
        if (!fits(clean)) break;
        this.aggs.delete(key);
      }
    }
    return out;
  }

  clear(): void {
    this.ring = [];
    this.aggs.clear();
    this.errors.clear();
  }
}

// ---------------------------------------------------------------------------------------------------
// The IndexedDB ring of built batches
// ---------------------------------------------------------------------------------------------------

export interface StoredBatch {
  /** Batch id: the server drops a repeat. */
  b: string;
  /** The session the events came from. */
  s: string;
  ev: TelEvent[];
  tries: number;
  /** Epoch ms it was built. */
  at: number;
  /** Not sent again before this (backoff). */
  next: number;
  /** A beacon carried it as the page hid: resent at the next start only (the server dedupes). */
  beacon?: boolean;
}

export interface BatchStore {
  all(): Promise<StoredBatch[]>;
  put(batch: StoredBatch): Promise<void>;
  del(ids: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

/** Stored batches to keep (younger than 24 h; at most 500 events, the oldest batches dropped first) and ids to delete. */
export function trimStored(list: readonly StoredBatch[], now: number, cap: number = TEL_LIMITS.idb): { keep: StoredBatch[]; drop: string[] } {
  const drop: string[] = [];
  const fresh = list
    .filter((b) => {
      const ok = !!b && typeof b.b === 'string' && Array.isArray(b.ev) && now - b.at <= TEL_LIMITS.storedMaxAgeMs && b.tries < TEL_LIMITS.maxTries;
      if (!ok && b && typeof b.b === 'string') drop.push(b.b);
      return ok;
    })
    .sort((a, b) => a.at - b.at);
  let total = fresh.reduce((n, b) => n + b.ev.length, 0);
  while (total > cap && fresh.length) {
    const old = fresh.shift() as StoredBatch;
    total -= old.ev.length;
    drop.push(old.b);
  }
  return { keep: fresh, drop };
}

/** An IDBRequest as a promise. */
function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * The browser's batch store: its own database (`lp-tel`, store `q`, keyed by batch id), separate from the store's
 * `lp-client`, so its transactions never queue behind the store's. Raw IndexedDB on purpose: importing idb-keyval here
 * would stop the bundler from inlining it into the first load's store module (A25: it cost ~490 B gzipped). Null where
 * IndexedDB is missing or can't open (a private window).
 */
export async function idbBatchStore(factory: IDBFactory | null = typeof indexedDB === 'undefined' ? null : indexedDB): Promise<BatchStore | null> {
  try {
    if (!factory) return null;
    const open = factory.open(TEL_IDB.db, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(TEL_IDB.store)) open.result.createObjectStore(TEL_IDB.store);
    };
    const db = await done(open);
    const run = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => {
      const tx = db.transaction(TEL_IDB.store, mode);
      const complete = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
      const req = fn(tx.objectStore(TEL_IDB.store));
      const result = req ? await done(req) : undefined;
      await complete;
      return result;
    };
    return {
      all: async () => ((await run('readonly', (st) => st.getAll())) ?? []) as StoredBatch[],
      put: async (batch) => {
        await run('readwrite', (st) => st.put(batch, batch.b));
      },
      del: async (ids) => {
        await run('readwrite', (st) => {
          for (const id of ids) st.delete(id);
        });
      },
      clear: async () => {
        await run('readwrite', (st) => st.clear());
      },
    };
  } catch {
    return null;
  }
}
