// The telemetry collector (design/references/observability-design.md §4). Loaded after idle by
// components/activity/use-telemetry.ts, from the F4 chunk: never on the first load. It observes what the app already
// exposes (the store's public contract, the DOM, timing APIs, window.fetch and the service worker) and changes none of
// it. Events are numbers, enums and attribute tokens only (lib/client/telemetry/sanitize.ts); they wait in memory and a
// small IndexedDB ring and go out about once a minute when the phone is idle (send.ts). Every handler is wrapped: a
// fault is counted, never rethrown, and 20 of them stop the collector for this page load.
import { FETCH_OBSERVER, SAMPLED, TEL_DEFAULT_UNTIL, TEL_KEYS, TEL_LIMITS, type TelView } from '../../telemetry';
import type { StoreState } from '../store-contract';
import type { MessagingApi } from '../messages-core';
import { EventBuffer, type Props, type TelEvent } from './buffer';
import { Crumbs, crumbStatus, secs } from './crumbs';
import { SLOW_MS, StuckSend } from './detect';
import { attachDom, newMarks, type DomWatch } from './dom';
import { describeError, describeResource } from './errors';
import { Flows } from './flows';
import { browserTelemetryHost, createGuard, deviceContext, idle, layoutOf, viewName, type Guard, type TelHost, type ViewInfo } from './host';
import { apiEntry, observeFetch, type FetchObserver, type NetEnd, type NetStart, type ResourceEntry } from './net';
import { firstClassToken, testid, type NodeLike } from './sanitize';
import { Sender, gzipText, randomId, type Answer, type KV } from './send';
import { takeSwLog } from './sw';

export { browserTelemetryHost };
export type { TelHost, ViewInfo };

export interface TelemetryHandle {
  view(view: ViewInfo): void;
  stop(): void;
  running(): boolean;
}

/** The check timer while visible: flows that ran out, stuck sends, device state, a send. */
export const CHECK_MS = 30_000;
const PUSH_STATE_MS = 5 * 60_000;
const VITALS_AFTER_MS = 60_000;
/** One api `slow` event (with its trail) per pattern and method per minute; the ones in between are its `k`. */
export const SLOW_API_COOLDOWN_MS = 60_000;
const SAMPLED_SET: ReadonlySet<string> = new Set(SAMPLED);

function safeKv(win: Window): KV {
  let storage: Storage | null = null;
  try {
    storage = win.localStorage;
  } catch {
    storage = null;
  }
  return {
    get: (k) => {
      try {
        return storage?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        storage?.setItem(k, v);
      } catch {
        // full or blocked: telemetry goes on without it
      }
    },
    remove: (k) => {
      try {
        storage?.removeItem(k);
      } catch {
        // as above
      }
    },
  };
}

function randomFrom(win: Window): () => number {
  const c = (win as Window & { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    return () => {
      const a = new Uint32Array(1);
      c.getRandomValues(a);
      return (a[0] as number) / 4_294_967_296;
    };
  }
  return Math.random;
}

/** Starts the collector. Nothing it does can throw into the caller. */
export function startTelemetry(host: TelHost): TelemetryHandle {
  let collector: Collector | null = null;
  try {
    collector = new Collector(host);
    collector.start();
  } catch {
    try {
      collector?.stop();
    } catch {
      // nothing more to undo
    }
    collector = null;
  }
  return {
    view: (v) => {
      try {
        collector?.setView(v);
      } catch {
        collector?.guard.fault();
      }
    },
    stop: () => {
      try {
        collector?.stop();
      } catch {
        // stopped as far as it could
      }
    },
    running: () => !!collector && collector.guard.alive,
  };
}

class Collector {
  readonly guard: Guard;
  private readonly win: Window;
  private readonly doc: Document;
  private readonly kv: KV;
  private readonly random: () => number;
  private readonly buffer = new EventBuffer();
  private readonly crumbs = new Crumbs();
  private readonly flows: Flows;
  private readonly marks = newMarks();
  private readonly stuckSend = new StuckSend();
  private sender: Sender | null = null;
  private dom: DomWatch | null = null;
  private fetchObs: FetchObserver | null = null;
  private readonly device: string;
  private readonly session: string;
  private readonly timeOrigin: number;
  private readonly started: number;
  private until: number;
  private sample = 1;
  private sampledSession: boolean | null = null;
  private prev: StoreState | null = null;
  /** (Post-event) lastSyncLocalAt when the running sync started: the store saves it before syncing goes false. */
  private syncFrom: number | null = null;
  private viewNow: TelView = 'unknown';
  private viewAt = 0;
  private visibleNow = true;
  private visAt = 0;
  private linkAt = 0;
  private connAt = 0;
  private messagesBound: MessagingApi | null = null;
  private deviceState = '';
  private pushState: 'sub' | 'none' | 'unsupported' | 'unk' = 'unk';
  private pushCheckedAt = 0;
  private vitalsSent = false;
  private vitals: { fcp?: number; lcp?: number; cls: number; inp?: number; lt: number; ltms: number } = { cls: 0, lt: 0, ltms: 0 };
  private hiddenFlushedAt = 0;
  private failures = new Map<string, number>();
  private rows2xx = new Map<string, TelEvent>();
  private fullSyncs = 0;
  private stopped = false;
  /** Per pattern|method: when the last api `slow` went out, and the slow ones since. */
  private slowApi = new Map<string, { at: number; k: number }>();
  /** The worker's log is taken after the first sync that follows a resume (or the next check), not in the resume itself. */
  private drainDue = false;
  /** A hidden page's beacon is refused where WebKit sends `Origin: null` without Sec-Fetch-Site (iOS before 16.4). */
  private beaconAccepted = true;

  constructor(private readonly host: TelHost) {
    this.win = host.win;
    this.doc = host.doc;
    this.guard = createGuard(() => this.cleanup());
    this.kv = safeKv(this.win);
    this.random = randomFrom(this.win);
    const perf = (this.win as Window & { performance?: Performance }).performance;
    this.timeOrigin = typeof perf?.timeOrigin === 'number' && perf.timeOrigin > 0 ? perf.timeOrigin : host.now();
    this.started = host.now();
    const untilRaw = Number(this.kv.get(TEL_KEYS.until));
    this.until = Number.isFinite(untilRaw) && untilRaw > 0 ? untilRaw : TEL_DEFAULT_UNTIL;
    let device = this.kv.get(TEL_KEYS.device);
    if (!device || !/^[a-z0-9]{16}$/.test(device)) {
      device = randomId(this.random, 16);
      this.kv.set(TEL_KEYS.device, device);
    }
    this.device = device;
    this.session = randomId(this.random, 10);
    this.flows = new Flows({
      now: () => host.now(),
      timeOrigin: this.timeOrigin,
      visible: () => this.visibleNow,
      desk: () => layoutOf(this.win.innerWidth || 0) !== 'phone',
      emit: (e) => this.emit(e),
      slow: (what, a, ms, p) => this.frustration({ n: 'slow', at: host.now(), a, ms, p: { what, ...(p ?? {}) } }),
    });
  }

  private now(): number {
    return this.host.now();
  }

  start(): void {
    if (this.now() >= this.until) return;
    this.visibleNow = this.doc.visibilityState !== 'hidden';
    this.visAt = this.now();
    this.linkAt = this.now();
    this.connAt = this.now();
    const native = typeof this.win.fetch === 'function' ? this.win.fetch : null;
    const send = native ? native.bind(this.win) : null;
    // CompressionStream arrived with Safari 16.4, as did Sec-Fetch-Site: the stand-in for "a beacon can be accepted".
    this.beaconAccepted = deviceContext(this.win).plat !== 'ios' || 'CompressionStream' in this.win;
    void this.host.batchStore().then(
      this.guard.wrap((store) => {
        if (!send) return;
        this.sender = new Sender({
          now: () => this.now(),
          fetch: send,
          beacon: (url, body) => (typeof this.win.navigator?.sendBeacon === 'function' ? this.win.navigator.sendBeacon(url, body) : false),
          canBeacon: () => this.beaconAccepted && !this.appBusy(),
          compress: gzipText,
          online: () => this.win.navigator?.onLine !== false,
          kv: this.kv,
          store,
          buffer: this.buffer,
          envelope: () => ({ d: this.device, ctx: { ...deviceContext(this.win) } }),
          session: this.session,
          quiet: () => this.quiet(),
          idle: (fn) => idle(this.win, this.guard.wrap(fn)),
          setTimeout: (fn, ms) => this.win.setTimeout(fn, ms),
          clearTimeout: (id) => this.win.clearTimeout(id as number),
          random: this.random,
          onOff: () => this.guard.stop(),
          onAnswer: (a, rt) => this.onAnswer(a, rt),
          onAuth: () => undefined,
        });
        const sender = this.sender;
        void sender.load().then(
          this.guard.wrap(() => {
            if (this.kv.get(TEL_KEYS.off) !== null) {
              // The server said off earlier: one empty probe before anything is attached.
              void sender.probe().then(
                this.guard.wrap((on: boolean) => {
                  if (!on) {
                    this.guard.stop();
                    return;
                  }
                  this.kv.remove(TEL_KEYS.off);
                  this.attach();
                }),
                () => this.guard.stop(),
              );
              return;
            }
            this.attach();
          }),
          () => this.guard.stop(),
        );
      }),
      () => this.guard.stop(),
    );
  }

  private attached = false;

  private attach(): void {
    if (this.attached || !this.guard.alive) return;
    this.attached = true;
    const { guard, win, doc, host } = this;
    const v = host.view();
    this.viewNow = viewName(v.name);
    this.viewAt = this.now();

    // Store, alerts, messages.
    guard.add(host.store.subscribe(guard.wrap(() => this.onStore())));
    guard.add(host.store.actions.subscribeAlerts(guard.wrap((alert) => this.flows.onAlert(alert, this.now()))));
    this.onStore();
    this.bindMessages();

    // Network.
    const origin = win.location?.origin ?? '';
    if (FETCH_OBSERVER && typeof win.fetch === 'function') {
      this.fetchObs = observeFetch(win as unknown as { fetch: typeof fetch }, {
        now: () => this.now(),
        origin,
        start: guard.wrap((req: NetStart) => this.onNetStart(req)),
        end: guard.wrap((req: NetEnd) => this.onNetEnd(req)),
        fault: () => guard.fault(),
      });
      guard.add(() => this.fetchObs?.stop());
    }
    this.observePerf(origin);

    // DOM.
    this.dom = attachDom({
      win,
      doc,
      guard,
      now: () => this.now(),
      view: () => this.viewNow,
      sampled: () => this.sampled(),
      emit: (e) => this.emit(e),
      frustration: (e) => this.frustration(e),
      crumb: (code, t) => this.crumbs.add(t ?? this.now(), code),
      agg: (key, make, update) => this.buffer.agg(key, make, update),
      marks: this.marks,
      onTap: (control, section, a, t) => {
        this.flows.onTap(control, section, t);
        if (a === 'lp-toaster' && this.prev?.updateReady) this.emit({ n: 'sw', at: t, ms: t - this.started, p: { what: 'reload_tap' } });
      },
      onField: (section, key, t) => this.flows.onField(section, key, t),
      onInvalid: () => this.flows.onInvalid(),
      idle: (fn) => idle(win, guard.wrap(fn)),
    });

    // Errors and failed resources.
    guard.on(win, 'error', (e) => this.onError(e));
    guard.on(win, 'unhandledrejection', (e) => {
      const r = e as PromiseRejectionEvent;
      this.recordError(describeError('rejection', r.reason, undefined, undefined, undefined, origin));
    });

    // Visibility, link, page lifecycle, the worker.
    // Bubble phase, not capture: registered long after the store's own listeners, these run after the app's "save now"
    // on hide (the draft and rows) and after its resume handling.
    guard.on(doc, 'visibilitychange', () => this.onVisibility(), { capture: false });
    guard.on(
      win,
      'pagehide',
      () => {
        this.flows.unload(this.now());
        this.flushHidden();
      },
      { capture: false },
    );
    guard.on(win, 'online', () => this.onLink(true));
    guard.on(win, 'offline', () => this.onLink(false));
    const sw = win.navigator?.serviceWorker;
    if (sw) guard.on(sw, 'controllerchange', () => this.emit({ n: 'sw', at: this.now(), ms: this.now() - this.started, p: { what: 'controller' } }));

    const check = win.setInterval(guard.wrap(() => this.check()), CHECK_MS);
    guard.add(() => win.clearInterval(check));
    const vitals = win.setTimeout(guard.wrap(() => this.emitVitals()), VITALS_AFTER_MS);
    guard.add(() => win.clearTimeout(vitals));

    this.appStart(v);
    if (!sw) this.emit({ n: 'sw', at: this.now(), ms: 0, p: { what: 'no_sw' } });
    this.checkDeviceState(true);
    this.drainSw();
  }

  // ---- Events --------------------------------------------------------------------------------------

  sampled(): boolean {
    if (this.sampledSession === null) return true;
    return this.sampledSession;
  }

  private emit(e: TelEvent): void {
    if (!this.guard.alive) return;
    if (SAMPLED_SET.has(e.n) && !this.sampled()) return;
    this.buffer.push({ v: this.viewNow, ...e });
  }

  private frustration(e: TelEvent): void {
    if (!this.guard.alive) return;
    const at = e.at ?? this.now();
    this.buffer.push({ v: this.viewNow, ...e, at, tr: this.crumbs.trail(at) });
  }

  private appStart(v: ViewInfo): void {
    const perf = (this.win as Window & { performance?: Performance }).performance;
    const p: Props = { cold: !this.win.navigator?.serviceWorker?.controller };
    try {
      const nav = perf?.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (nav) {
        p.nav = nav.type === 'navigate' || nav.type === 'reload' || nav.type === 'back_forward' ? nav.type : 'other';
        if (nav.responseStart > 0) p.ttfb = Math.round(nav.responseStart);
        if (nav.domContentLoadedEventEnd > 0) p.dcl = Math.round(nav.domContentLoadedEventEnd);
        if (nav.loadEventEnd > 0) p.load = Math.round(nav.loadEventEnd);
      }
      const fcp = perf?.getEntriesByName?.('first-contentful-paint')[0];
      if (fcp) p.fcp = Math.round(fcp.startTime);
    } catch {
      // timing is optional
    }
    const upd = Number(this.kv.get(TEL_KEYS.updated));
    if (Number.isFinite(upd) && upd > 0) {
      p.upd = Math.max(0, Math.round(this.timeOrigin - upd));
      this.kv.remove(TEL_KEYS.updated);
    }
    this.emit({ n: 'app_start', at: this.now(), v: viewName(v.name), ms: Math.max(0, Math.round(this.started - this.timeOrigin)), p });
    this.emit({ n: 'view', at: this.now(), v: viewName(v.name), p: { from: 'start', lay: layoutOf(this.win.innerWidth || 0), filter: v.filter ?? 'none' } });
    this.crumbs.add(this.now(), `v>${viewName(v.name)}`);
  }

  setView(v: ViewInfo): void {
    if (!this.attached || !this.guard.alive) return;
    const name = viewName(v.name);
    const t = this.now();
    if (name === this.viewNow) return;
    const prev = this.viewNow;
    const dwell = Math.max(0, t - this.viewAt);
    this.viewNow = name;
    this.viewAt = t;
    this.marks.view = t;
    const lay = layoutOf(this.win.innerWidth || 0);
    const p: Props = { from: prev, lay, filter: v.filter ?? 'none' };
    if (lay !== 'phone' && (name === 'profile' || name === 'edit')) p.pane = true;
    this.emit({ n: 'view', at: t, v: name, ms: dwell, p });
    this.crumbs.add(t, `v>${name}`);
    this.flows.onView(name, prev, t);
    this.dom?.viewChanged(prev, name, dwell, t);
  }

  // ---- Store ---------------------------------------------------------------------------------------

  private bindMessages(): void {
    const api = this.host.store.actions.messages;
    if (!api || this.messagesBound === api) return;
    this.messagesBound = api;
    this.guard.add(
      api.subscribe(
        this.guard.wrap(() => {
          const snap = api.getSnapshot();
          if (snap.jobs.some((j) => j.state === 'sending')) this.sender?.yieldToApp();
          this.flows.onMessages(snap);
        }),
      ),
    );
    this.flows.onMessages(api.getSnapshot());
  }

  private onStore(): void {
    const s = this.host.store.getState();
    const prev = this.prev;
    this.prev = s;
    const t = this.now();
    this.marks.store = t;
    if (s.syncing || s.outbox.some((j) => j.state === 'sending')) this.sender?.yieldToApp();
    if (prev && sessionChanged(prev, s)) {
      void this.sender?.clearAll();
      this.crumbs.clear();
    }
    if (prev && prev.session.status !== 'active' && s.session.status === 'active') this.sender?.resumeAuth();
    if (prev && prev.connection !== s.connection) {
      this.emit({ n: 'link', at: t, ok: s.connection === 'live', ms: t - this.connAt, p: { what: 'conn', to: s.connection } });
      this.connAt = t;
      this.crumbs.add(t, `c:${s.connection}`);
    }
    if (s.syncing && !prev?.syncing) this.syncFrom = s.lastSyncLocalAt;
    if (prev?.syncing && !s.syncing) {
      const ok = s.lastSyncLocalAt !== null && s.lastSyncLocalAt !== this.syncFrom;
      this.buffer.agg(
        'sync',
        () => ({ n: 'sync', at: t, k: 0, p: { ok: 0, fail: 0, full: 0, age: 0 } }),
        (e) => {
          const p = e.p as Props;
          e.k = (e.k ?? 0) + 1;
          if (ok) p.ok = (p.ok as number) + 1;
          else p.fail = (p.fail as number) + 1;
          p.full = this.fullSyncs;
        },
      );
    }
    if (this.visibleNow && s.lastSyncLocalAt !== null) {
      const age = Math.round((t - s.lastSyncLocalAt) / 1000);
      this.buffer.agg(
        'sync',
        () => ({ n: 'sync', at: t, k: 0, p: { ok: 0, fail: 0, full: 0, age: 0 } }),
        (e) => {
          const p = e.p as Props;
          if (age > (p.age as number)) p.age = Math.min(86_400, age);
        },
      );
    }
    const jobs = this.messagesBound?.getSnapshot().jobs ?? [];
    if (s.outbox.length > 0 || jobs.length > 0) {
      const attn = s.outbox.filter((j) => j.state === 'needs_attention').length;
      this.buffer.agg(
        'outbox',
        () => ({ n: 'outbox', at: t, p: { max: 0, end: 0, attn: 0, mq: 0 } }),
        (e) => {
          const p = e.p as Props;
          p.max = Math.max(p.max as number, s.outbox.length);
          p.end = s.outbox.length;
          p.attn = Math.max(p.attn as number, attn);
          p.mq = Math.max(p.mq as number, jobs.length);
        },
      );
    }
    if (prev && !prev.updateReady && s.updateReady) {
      this.emit({ n: 'sw', at: t, ms: t - this.started, p: { what: 'update_ready' } });
      this.kv.set(TEL_KEYS.updated, String(t));
    }
    if (prev && !prev.offlineReady && s.offlineReady) this.emit({ n: 'sw', at: t, ms: t - this.started, p: { what: 'offline_ready' } });
    const tones: string[] = [];
    if (prev && prev.toasts !== s.toasts) {
      const before = new Set(prev.toasts.map((x) => x.id));
      for (const toast of s.toasts) {
        if (before.has(toast.id)) continue;
        tones.push(toast.tone);
        this.crumbs.add(t, `toast:${toast.tone}:${toast.icon}`);
      }
    }
    this.flows.onState(s, prev, tones);
    this.checkStuckSend(s, t);
    if (prev?.syncing && !s.syncing) {
      if (this.drainDue && this.visibleNow) {
        this.drainDue = false;
        this.drainSw();
      }
      this.sender?.maybeSend();
    }
  }

  private checkStuckSend(s: StoreState, t: number): void {
    const jobs = this.messagesBound?.getSnapshot().jobs ?? [];
    const ids = [
      ...s.outbox.filter((j) => j.state !== 'needs_attention').map((j) => `o:${j.mutationId}`),
      ...jobs.filter((j) => j.state !== 'failed').map((j) => `m:${j.id}`),
    ];
    const healthy = this.win.navigator?.onLine !== false && s.connection === 'live';
    for (const hit of this.stuckSend.check(ids, healthy, t)) {
      const q = hit.id.startsWith('o:') ? 'outbox' : 'message';
      this.frustration({ n: 'stuck_send', at: t, p: { q, depth: q === 'outbox' ? s.outbox.length : jobs.length, age: hit.age } });
    }
  }

  /** An app request, outbox job or message job in flight. */
  private appBusy(): boolean {
    const s = this.host.store.getState();
    if (s.outbox.some((j) => j.state === 'sending')) return true;
    if ((this.messagesBound?.getSnapshot().jobs ?? []).some((j) => j.state === 'sending')) return true;
    return !!this.fetchObs && this.fetchObs.inflight() > 0;
  }

  private quiet(): boolean {
    const s = this.host.store.getState();
    if (!this.visibleNow || this.win.navigator?.onLine === false) return false;
    if (s.connection !== 'live' || s.session.status !== 'active' || s.syncing) return false;
    if (this.appBusy()) return false;
    return this.now() - this.marks.tap >= 1_500;
  }

  // ---- Network -------------------------------------------------------------------------------------

  private onNetStart(req: NetStart): void {
    // The app's request goes first: a telemetry send in flight steps aside.
    this.sender?.yieldToApp();
    this.marks.api = req.t;
    if (req.pattern === '/api/sync:full') this.fullSyncs += 1;
    this.flows.onNetStart(req);
  }

  private onNetEnd(req: NetEnd): void {
    const s = this.prev;
    const ms = Math.max(0, req.end - req.t);
    const on = this.win.navigator?.onLine !== false;
    const conn = s?.connection ?? 'live';
    const key = `${req.pattern}|${req.method}`;
    const failedAt = this.failures.get(key);
    const retry = failedAt !== undefined && req.t - failedAt <= 30_000;
    if (req.st === '5xx' || req.st === 'net' || req.st === 'timeout') this.failures.set(key, req.end);
    this.recordNet(req.pattern, req.method, req.st, ms, on, conn, retry, req.end);
    this.crumbs.add(req.end, `n:${req.pattern}:${crumbStatus(req.st)}:${secs(ms)}`);
    if (ms > (SLOW_MS.api ?? 3_000)) {
      // On a slow festival link most polls are slow: one event (and one trail) per pattern per minute, `k` counting the
      // slow ones it stands for.
      const seen = this.slowApi.get(key);
      if (seen && req.end - seen.at < SLOW_API_COOLDOWN_MS) {
        seen.k += 1;
      } else {
        const k = (seen?.k ?? 0) + 1;
        this.slowApi.set(key, { at: req.end, k: 0 });
        const eff = (this.win.navigator as Navigator & { connection?: { effectiveType?: string } })?.connection?.effectiveType ?? 'na';
        this.frustration({ n: 'slow', at: req.end, a: req.pattern, ms, k, p: { what: 'api', m: req.method, st: req.st, on, conn, eff } });
      }
    }
    this.flows.onNetEnd(req);
  }

  private recordNet(pattern: string, m: string, st: string, ms: number, on: boolean, conn: string, retry: boolean, at: number): void {
    const key = `net|${pattern}|${m}|${st}|${on}|${conn}`;
    this.buffer.agg(
      key,
      () => {
        const e: TelEvent = { n: 'net', at, a: pattern, k: 0, p: { m, st, on, conn, d: [] } };
        if (st === '2xx') this.rows2xx.set(pattern, e);
        return e;
      },
      (e) => {
        const p = e.p as Props;
        e.k = (e.k ?? 0) + 1;
        const d = p.d as number[];
        if (d.length < TEL_LIMITS.durations) d.push(Math.round(ms));
        if (retry) p.retry = ((p.retry as number) ?? 0) + 1;
      },
    );
  }

  private observePerf(origin: string): void {
    const PO = (this.win as Window & { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
    if (typeof PO !== 'function') return;
    const installed = this.now() - this.timeOrigin;
    const observe = (type: string, fn: (entries: PerformanceEntry[]) => void, extra: Record<string, unknown> = {}) => {
      try {
        const po = new PO(this.guard.wrap((list: PerformanceObserverEntryList) => fn(list.getEntries())));
        po.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
        this.guard.add(() => po.disconnect());
      } catch {
        // an engine without this entry type
      }
    };
    observe('resource', (entries) => {
      for (const raw of entries) {
        const entry = raw as unknown as ResourceEntry;
        const api = apiEntry(entry, origin);
        if (!api) continue;
        if (api.pattern.startsWith('/api/sync')) this.flows.syncApiAt(entry.startTime);
        const before = entry.startTime < installed;
        if (before || !this.fetchObs) {
          this.recordNet(api.pattern, 'get', api.st, Math.round(entry.duration), true, 'live', false, this.timeOrigin + entry.startTime);
        }
        const size = entry.transferSize;
        const row = this.rows2xx.get(api.pattern);
        if (row && typeof size === 'number' && size > 0) {
          const p = row.p as Props;
          p.bytes = ((p.bytes as number) ?? 0) + size;
        }
      }
    });
    observe('paint', (entries) => {
      for (const e of entries) if (e.name === 'first-contentful-paint') this.vitals.fcp = Math.round(e.startTime);
    });
    observe('largest-contentful-paint', (entries) => {
      const last = entries[entries.length - 1];
      if (last) this.vitals.lcp = Math.round(last.startTime);
    });
    observe('layout-shift', (entries) => {
      for (const e of entries as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>) if (!e.hadRecentInput) this.vitals.cls += e.value ?? 0;
    });
    observe(
      'event',
      (entries) => {
        for (const e of entries) this.vitals.inp = Math.max(this.vitals.inp ?? 0, Math.round(e.duration));
      },
      { durationThreshold: 104 },
    );
    observe('longtask', (entries) => {
      for (const e of entries) {
        this.vitals.lt += 1;
        this.vitals.ltms += Math.round(e.duration);
      }
    });
  }

  // ---- Errors --------------------------------------------------------------------------------------

  private onError(e: Event): void {
    const origin = this.win.location?.origin ?? '';
    const target = e.target as unknown as (NodeLike & { nodeType?: number; getAttribute?(n: string): string | null }) | null;
    if (target && target !== (this.win as unknown) && target.nodeType === 1) {
      const tag = (target.tagName ?? '').toLowerCase();
      if (tag === 'img') {
        const name = `${testid(target) ?? ''} ${firstClassToken(target) ?? ''}`;
        const kind = /photo/.test(name) ? 'photo' : /thumb/.test(name) ? 'thumb' : /icon/.test(name) ? 'icon' : /logo/.test(name) ? 'logo' : 'other';
        this.buffer.agg(`img|${kind}`, () => ({ n: 'img_fail', at: this.now(), a: kind, k: 0 }), (ev) => (ev.k = (ev.k ?? 0) + 1));
        return;
      }
      // A failed chunk: its own URL attribute, script and stylesheet only (a static asset path, hashed).
      const url = tag === 'script' ? target.getAttribute?.('src') : tag === 'link' ? target.getAttribute?.('href') : null;
      const info = describeResource(tag, url, origin);
      if (info) this.recordError(info);
      return;
    }
    const ee = e as ErrorEvent;
    this.recordError(describeError('error', ee.error, ee.filename, ee.lineno, ee.colno, origin));
  }

  private recordError(info: ReturnType<typeof describeError>): void {
    const t = this.now();
    this.crumbs.add(t, `e:${info.type}`);
    const p: Props = { type: info.type, kind: info.kind, fp: info.fp };
    if (info.line !== undefined) p.line = info.line;
    if (info.col !== undefined) p.col = info.col;
    this.buffer.pushError(info.fp, { n: 'error', at: t, v: this.viewNow, a: info.src, c: info.type, p, tr: this.crumbs.trail(t) });
  }

  // ---- Lifecycle -----------------------------------------------------------------------------------

  private onVisibility(): void {
    const visible = this.doc.visibilityState !== 'hidden';
    if (visible === this.visibleNow) return;
    const t = this.now();
    this.emit({ n: 'vis', at: t, ok: visible, ms: t - this.visAt });
    this.visAt = t;
    this.visibleNow = visible;
    this.crumbs.add(t, visible ? 'u' : 'h');
    this.flows.onVisibility(visible, t);
    if (!visible) {
      this.emitVitals();
      this.flushHidden();
      return;
    }
    // Nothing here on resume: the app's session check, resume sync and notification hand-off go first. The worker's log
    // is taken after the first sync that follows (or at the next check), and a send waits for that sync too.
    this.drainDue = true;
  }

  private flushHidden(): void {
    const t = this.now();
    if (t - this.hiddenFlushedAt < 1_000) return;
    this.hiddenFlushedAt = t;
    this.sender?.flushHidden();
  }

  private onLink(online: boolean): void {
    const t = this.now();
    this.emit({ n: 'link', at: t, ok: online, ms: t - this.linkAt, p: { what: 'link', to: online ? 'online' : 'offline' } });
    this.linkAt = t;
    this.crumbs.add(t, online ? 'x:online' : 'x:offline');
  }

  private emitVitals(): void {
    if (this.vitalsSent) return;
    this.vitalsSent = true;
    const v = this.vitals;
    const p: Props = { cls: Math.round(v.cls * 1000), lt: v.lt, ltms: v.ltms };
    if (v.fcp !== undefined) p.fcp = v.fcp;
    if (v.lcp !== undefined) p.lcp = v.lcp;
    if (v.inp !== undefined) p.inp = v.inp;
    this.emit({ n: 'vitals', at: this.now(), p });
  }

  private drainSw(): void {
    void takeSwLog(this.win.navigator?.serviceWorker, (fn, ms) => this.win.setTimeout(this.guard.wrap(fn), ms)).then(
      this.guard.wrap((entries) => {
        if (entries.length) this.flows.onSwEntries(entries);
        this.flows.settleHidden(this.now());
      }),
      () => undefined,
    );
  }

  private checkDeviceState(force = false): void {
    const s = this.host.store.getState();
    const nav = this.win.navigator as Navigator & { standalone?: boolean; setAppBadge?: unknown };
    const N = (this.win as Window & { Notification?: { permission?: string } }).Notification;
    const perm = N && typeof N.permission === 'string' ? N.permission : 'unsupported';
    const ctx = deviceContext(this.win);
    const appleTouch = ctx.plat === 'ios';
    const notif = !!N && !!nav?.serviceWorker && !(appleTouch && !ctx.sa);
    const p: Props = { perm: ['default', 'granted', 'denied'].includes(perm) ? perm : 'unsupported', notif, push: this.pushState, newreq: s.prefs.bell, sa: ctx.sa, badge: typeof nav?.setAppBadge === 'function' };
    const key = JSON.stringify(p);
    if (force || key !== this.deviceState) {
      this.deviceState = key;
      this.emit({ n: 'device_state', at: this.now(), p });
    }
    if (this.now() - this.pushCheckedAt >= PUSH_STATE_MS || force) {
      this.pushCheckedAt = this.now();
      void this.readPushState().then(
        this.guard.wrap((state: Collector['pushState']) => {
          if (state === this.pushState) return;
          this.pushState = state;
          this.checkDeviceState();
        }),
        () => undefined,
      );
    }
  }

  private async readPushState(): Promise<Collector['pushState']> {
    try {
      const sw = this.win.navigator?.serviceWorker;
      if (!sw || !('PushManager' in this.win)) return 'unsupported';
      const reg = await sw.getRegistration();
      if (!reg?.pushManager) return 'unsupported';
      return (await reg.pushManager.getSubscription()) ? 'sub' : 'none';
    } catch {
      return 'unk';
    }
  }

  private check(): void {
    const t = this.now();
    if (t >= this.until) {
      this.guard.stop();
      return;
    }
    this.bindMessages();
    this.flows.tick(t, this.prev?.connection === 'offline');
    if (this.prev) this.checkStuckSend(this.prev, t);
    if (this.visibleNow) {
      if (this.drainDue) {
        this.drainDue = false;
        this.drainSw();
      }
      this.checkDeviceState();
      this.dom?.process();
      this.sender?.maybeSend();
    }
  }

  private onAnswer(a: Answer, [sent, answered]: [number, number]): void {
    if (typeof a.until === 'number' && a.until > 0) {
      this.until = a.until;
      this.kv.set(TEL_KEYS.until, String(a.until));
      if (this.now() >= a.until) this.guard.stop();
    }
    if (typeof a.sample === 'number' && a.sample >= 0 && a.sample <= 1) {
      this.sample = a.sample;
      if (this.sampledSession === null) this.sampledSession = this.random() < this.sample;
    }
    if (typeof a.now === 'number' && !this.prev?.lastSyncAt) this.flows.setSkew(a.now - (sent + answered) / 2);
  }

  // ---- Stop ----------------------------------------------------------------------------------------

  stop(): void {
    this.guard.stop();
  }

  private cleanup(): void {
    if (this.stopped) return;
    this.stopped = true;
    // Listeners, observers, timers and the fetch observer came off with the guard.
    this.sender?.stop();
    this.buffer.clear();
    this.crumbs.clear();
  }
}

function sessionChanged(prev: StoreState, s: StoreState): boolean {
  if (prev.generation !== s.generation) return true;
  if (prev.session.status === 'active' && s.session.status !== 'active' && s.session.status !== 'unknown') return true;
  return !!prev.session.staff && !!s.session.staff && prev.session.staff !== s.session.staff;
}
