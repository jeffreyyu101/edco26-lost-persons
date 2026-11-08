// Sending (design §4.4). A send only happens when the phone is online, visible, idle (no sync, outbox job, message
// job or other /api request in flight, no tap in the last 1.5 s), at most once a minute for discrete events (every 5
// minutes when only counts wait), with the body gzipped where CompressionStream exists. It never goes through the
// store's request path and adds nothing to any app request: when the app starts a request of its own while a send is
// in flight, the send is aborted (yieldToApp) and its batch kept as if it was never sent (no try counted, no backoff).
// A hidden page hands its batch to sendBeacon only when the app has nothing in flight and the beacon can be accepted;
// a beaconed batch is not kept (a lost beacon is accepted), anything else waits in IndexedDB for the next visible
// moment. A failed send is tried 3 times, 5 minutes apart, then dropped. The server's 204 turns everything off.
import { TEL_GZIP_TYPE, TEL_KEYS, TEL_LIMITS, TEL_PATH, TEL_VERSION } from '../../telemetry';
import type { BatchStore, EventBuffer, StoredBatch, TelEvent } from './buffer';
import { trimStored } from './buffer';

export interface Envelope {
  d: string;
  ctx: Record<string, unknown>;
}

export interface Answer {
  until?: number;
  flushSeconds?: number;
  sample?: number;
  /** Server clock (epoch ms) when it answered. */
  now?: number;
  capped?: boolean;
}

export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface SenderDeps {
  now(): number;
  /** The page's own fetch as it was before the collector started (never the observed one). */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  beacon(url: string, body: string): boolean;
  /** Whether a hidden page may beacon now: nothing of the app's in flight, and a beacon this engine's can be accepted. */
  canBeacon(): boolean;
  compress(text: string): Promise<ArrayBuffer | null>;
  online(): boolean;
  kv: KV;
  store: BatchStore | null;
  buffer: EventBuffer;
  envelope(): Envelope;
  session: string;
  /** Every idle condition (visible, online, live, signed in, nothing in flight, no recent tap). */
  quiet(): boolean;
  /** Runs `fn` in idle time. */
  idle(fn: () => void): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  random(): number;
  /** 204: collection is off. */
  onOff(): void;
  /** 200: the server's settings and clock. `roundTrip` is [sent, answered] on this device's clock. */
  onAnswer(answer: Answer, roundTrip: [number, number]): void;
  /** 401 / 403: pause until the session is active again. */
  onAuth(): void;
}

/** 12 random base36 characters (a batch id). */
export function randomId(random: () => number, length: number): string {
  let s = '';
  while (s.length < length) s += Math.floor(random() * 36).toString(36);
  return s;
}

/** gzip through CompressionStream, or null where it is missing or fails. */
export async function gzipText(text: string): Promise<ArrayBuffer | null> {
  try {
    const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
    if (!CS) return null;
    return await new Response(new Blob([text]).stream().pipeThrough(new CS('gzip'))).arrayBuffer();
  } catch {
    return null;
  }
}

export class Sender {
  private stored: StoredBatch[] = [];
  private busy = false;
  private lastSend = 0;
  private backoffUntil = 0;
  private pausedUntil = 0;
  private authPaused = false;
  private stopped = false;
  private flushMs: number = TEL_LIMITS.flushSeconds * 1000;
  /** The last answer's status (0: no answer). */
  private lastStatus = 0;
  /** The send in flight (aborted when the app starts a request of its own). */
  private inflight: AbortController | null = null;
  private yielded = false;
  /** The current batch's session for probes and new batches. */
  constructor(private readonly deps: SenderDeps) {}

  /** Loads the batches stored by earlier pages (they go first, beacon copies included). */
  async load(): Promise<void> {
    const store = this.deps.store;
    if (!store) return;
    try {
      const { keep, drop } = trimStored(await store.all(), this.deps.now());
      if (drop.length) await store.del(drop);
      this.stored = keep.map((b) => ({ ...b, beacon: false, next: 0 }));
    } catch {
      this.stored = [];
    }
  }

  setFlushSeconds(seconds: number): void {
    if (Number.isFinite(seconds) && seconds >= 30 && seconds <= 3600) this.flushMs = seconds * 1000;
  }

  pauseUntil(t: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, t);
  }

  resumeAuth(): void {
    this.authPaused = false;
  }

  get storedCount(): number {
    return this.stored.length;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Forget everything waiting (another staff signed in, or signed out). */
  async clearAll(): Promise<void> {
    this.stored = [];
    this.deps.buffer.clear();
    try {
      await this.deps.store?.clear();
    } catch {
      // nothing to keep anyway
    }
  }

  /** Whether a send is due now (spacing, backoff, pauses), before the idle conditions. */
  due(now: number = this.deps.now()): boolean {
    if (this.stopped || this.busy || this.authPaused || now < this.pausedUntil || now < this.backoffUntil) return false;
    if (this.stored.some((b) => !b.beacon && b.next <= now)) return now - this.lastSend >= Math.min(this.flushMs, 60_000) || this.lastSend === 0;
    const since = now - this.lastSend;
    if (this.deps.buffer.discrete > 0) return since >= this.flushMs;
    if (this.deps.buffer.aggregates > 0) return since >= this.flushMs * TEL_LIMITS.aggregateFactor;
    return false;
  }

  /**
   * The app started a request of its own (or a sync, an outbox or a message send): a send in flight steps aside so it
   * never shares the link with it. Its batch is kept as if never sent.
   */
  yieldToApp(): void {
    if (!this.inflight) return;
    this.yielded = true;
    this.inflight.abort();
  }

  /** Sends one batch when due and quiet, in idle time. */
  maybeSend(): void {
    if (!this.due() || !this.deps.quiet()) return;
    this.busy = true;
    this.deps.idle(() => {
      void this.sendOne().finally(() => {
        this.busy = false;
      });
    });
  }

  private build(ev: TelEvent[], b: string, s: string, sent: number, probe = false): string {
    const env = this.deps.envelope();
    return JSON.stringify({ v: TEL_VERSION, b, d: env.d, s, sent, ...(probe ? { probe: 1 } : {}), ctx: env.ctx, ev });
  }

  private newBatch(): StoredBatch | null {
    const ev = this.deps.buffer.take();
    if (ev.length === 0) return null;
    const now = this.deps.now();
    return { b: randomId(this.deps.random, 12), s: this.deps.session, ev, tries: 0, at: now, next: 0 };
  }

  private async sendOne(): Promise<void> {
    // The quiet check again, now that idle came: a sync may have started meanwhile.
    if (this.stopped || !this.deps.quiet()) return;
    const now = this.deps.now();
    const retry = this.stored.find((b) => !b.beacon && b.next <= now);
    const batch = retry ?? this.newBatch();
    if (!batch) return;
    this.lastSend = now;
    const outcome = await this.post(this.build(batch.ev, batch.b, batch.s, now));
    if (outcome === 'yield') {
      // Stepped aside for the app: not a try, no backoff; it goes again at the next quiet, due moment (same id, so the
      // server dedupes one that landed anyway).
      if (!retry) {
        this.stored.push(batch);
        void this.deps.store?.put(batch).catch(() => undefined);
      }
      return;
    }
    if (outcome === 'retry') {
      this.backoffUntil = this.deps.now() + TEL_LIMITS.backoffMs;
      batch.tries += 1;
      batch.next = this.deps.now() + TEL_LIMITS.backoffMs;
      if (batch.tries >= TEL_LIMITS.maxTries) {
        this.forget(batch.b);
        return;
      }
      if (!retry) this.stored.push(batch);
      void this.deps.store?.put(batch).catch(() => undefined);
      return;
    }
    // Delivered, refused for good, or off: never sent again.
    this.forget(batch.b);
  }

  private forget(b: string): void {
    this.stored = this.stored.filter((x) => x.b !== b);
    void this.deps.store?.del([b]).catch(() => undefined);
  }

  /** One POST. 'done': delivered or refused for good; 'retry': 5xx, network or timeout; 'off': 204; 'yield': aborted for the app. */
  async post(json: string): Promise<'done' | 'retry' | 'off' | 'yield'> {
    const started = this.deps.now();
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    this.inflight = controller;
    this.yielded = false;
    this.lastStatus = 0;
    const gz = await this.deps.compress(json);
    if (this.yielded) {
      this.inflight = null;
      return 'yield';
    }
    const timer = this.deps.setTimeout(() => controller?.abort(), TEL_LIMITS.sendTimeoutMs);
    let res: Response;
    try {
      res = await this.deps.fetch(TEL_PATH, {
        method: 'POST',
        body: gz ?? json,
        headers: { 'Content-Type': gz ? TEL_GZIP_TYPE : 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: false,
        priority: 'low',
        signal: controller?.signal,
      } as RequestInit);
    } catch {
      return this.yielded ? 'yield' : 'retry';
    } finally {
      this.deps.clearTimeout(timer);
      this.inflight = null;
    }
    this.lastStatus = res.status;
    if (res.status === 204) {
      this.turnOff();
      return 'off';
    }
    if (res.status === 200) {
      let answer: Answer = {};
      try {
        answer = (await res.json()) as Answer;
      } catch {
        answer = {};
      }
      if (answer.capped) this.pauseUntil(nextHour(this.deps.now()));
      if (typeof answer.flushSeconds === 'number') this.setFlushSeconds(answer.flushSeconds);
      try {
        this.deps.onAnswer(answer, [started, this.deps.now()]);
      } catch {
        // the answer's side effects never break sending
      }
      return 'done';
    }
    if (res.status === 401 || res.status === 403) {
      this.authPaused = true;
      this.deps.onAuth();
      return 'done';
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return 'done';
    return 'retry';
  }

  /** The probe after an off: an empty batch that writes nothing. True when collection is on again. */
  async probe(): Promise<boolean> {
    const now = this.deps.now();
    const outcome = await this.post(this.build([], randomId(this.deps.random, 12), this.deps.session, now, true));
    return outcome === 'done' && this.lastStatus === 200 && !this.stopped;
  }

  private turnOff(): void {
    this.stopped = true;
    try {
      this.deps.kv.set(TEL_KEYS.off, String(this.deps.now() + TEL_LIMITS.offProbeMs));
    } catch {
      // the gate also stops at `until`
    }
    void this.clearAll();
    this.deps.onOff();
  }

  /**
   * The page is hiding: everything waiting becomes one batch, handed to sendBeacon (uncompressed: there is no time to
   * compress; only when online, ≤ 48 KB, and canBeacon) and then forgotten, or else stored in IndexedDB for the next
   * visible moment.
   */
  flushHidden(): void {
    if (this.stopped) return;
    const batch = this.newBatch();
    if (!batch) return;
    let beaconed = false;
    try {
      if (this.deps.online() && !this.authPaused && this.deps.canBeacon()) {
        const json = this.build(batch.ev, batch.b, batch.s, this.deps.now());
        beaconed = json.length <= TEL_LIMITS.batchBytes && this.deps.beacon(TEL_PATH, json);
      }
    } catch {
      beaconed = false;
    }
    // Handed over: not kept (resending it at the next start would upload it twice, ahead of new data).
    if (beaconed) return;
    this.stored.push(batch);
    const { keep, drop } = trimStored(this.stored, this.deps.now());
    this.stored = keep;
    void this.deps.store?.put(batch).catch(() => undefined);
    if (drop.length) void this.deps.store?.del(drop).catch(() => undefined);
  }
}

export function nextHour(t: number): number {
  return Math.floor(t / 3_600_000) * 3_600_000 + 3_600_000;
}
