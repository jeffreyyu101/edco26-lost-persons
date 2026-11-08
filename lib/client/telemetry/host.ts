// What the collector runs against (the page, or a test's fakes), the guard every handler goes through, and the
// device context sent once per batch. Telemetry must never throw into the app: every listener is passive and wrapped,
// a fault is counted, and the 20th fault stops the collector for this page load. Nothing is ever rethrown.
import { EFFECTIVE, type TelView } from '../../telemetry';
import type { AlertEvent, StoreState } from '../store-contract';
import type { MessagingApi } from '../messages-core';
import { idbBatchStore, type BatchStore } from './buffer';

/** The store's public contract, as far as the collector reads it. */
export interface StoreLike {
  getState(): StoreState;
  subscribe(listener: () => void): () => void;
  actions: {
    messages?: MessagingApi;
    subscribeAlerts(listener: (alert: AlertEvent) => void): () => void;
  };
}

export interface ViewInfo {
  name: string;
  filter?: 'status' | 'post' | 'none';
}

export interface TelHost {
  win: Window;
  doc: Document;
  store: StoreLike;
  view(): ViewInfo;
  now(): number;
  batchStore(): Promise<BatchStore | null>;
}

/** The page's own host. */
export function browserTelemetryHost(store: StoreLike, view: () => ViewInfo): TelHost {
  return { win: window, doc: document, store, view, now: () => Date.now(), batchStore: idbBatchStore };
}

export const MAX_FAULTS = 20;

export interface Guard {
  readonly alive: boolean;
  readonly faults: number;
  /** A passive listener (capture unless said otherwise), wrapped, removed at stop. */
  on(target: EventTarget | null | undefined, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void;
  /** `fn` wrapped: nothing runs after stop, and nothing it throws escapes. */
  wrap<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void;
  /** Runs at stop. */
  add(off: () => void): void;
  fault(): void;
  stop(): void;
}

export function createGuard(onStop: () => void = () => undefined): Guard {
  let alive = true;
  let faults = 0;
  const offs: Array<() => void> = [];
  const stop = () => {
    if (!alive) return;
    alive = false;
    for (const off of offs.splice(0).reverse()) {
      try {
        off();
      } catch {
        // keep going: everything else must still come off
      }
    }
    try {
      onStop();
    } catch {
      // nothing to do
    }
  };
  const fault = () => {
    faults += 1;
    if (faults >= MAX_FAULTS) stop();
  };
  const wrap = <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      if (!alive) return;
      try {
        fn(...args);
      } catch {
        fault();
      }
    };
  return {
    get alive() {
      return alive;
    },
    get faults() {
      return faults;
    },
    on(target, type, fn, opts = {}) {
      if (!target || typeof target.addEventListener !== 'function') return;
      const handler = wrap(fn);
      const options: AddEventListenerOptions = { passive: true, capture: true, ...opts };
      target.addEventListener(type, handler, options);
      offs.push(() => target.removeEventListener(type, handler, { capture: options.capture }));
    },
    wrap,
    add(off) {
      if (alive) offs.push(off);
      else off();
    },
    fault,
    stop,
  };
}

/** Runs `fn` in idle time: requestIdleCallback where it exists (Chromium), else a 250 ms timer (Safari). */
export function idle(win: Window, fn: () => void, timeout = 2_000): () => void {
  const w = win as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(fn, { timeout });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = win.setTimeout(fn, 250);
  return () => win.clearTimeout(id);
}

/** The view name as an enum value. */
export function viewName(name: string | undefined): TelView {
  switch (name) {
    case 'all':
    case 'pending':
    case 'mine':
    case 'search':
    case 'new':
    case 'profile':
    case 'edit':
    case 'dashboard':
    case 'outbox':
      return name;
    default:
      return 'unknown';
  }
}

/** phone < 768 ≤ tablet < 1024 ≤ laptop < 1280 ≤ desktop (components/desk/breakpoints.ts layoutFor). */
export function layoutOf(width: number): 'phone' | 'tablet' | 'laptop' | 'desktop' {
  if (width >= 1280) return 'desktop';
  if (width >= 1024) return 'laptop';
  if (width >= 768) return 'tablet';
  return 'phone';
}

export interface DeviceContext {
  plat: 'ios' | 'android' | 'mac' | 'windows' | 'linux' | 'other';
  osv: number;
  eng: 'webkit' | 'blink' | 'gecko' | 'other';
  sa: boolean;
  lay: 'phone' | 'tablet' | 'laptop' | 'desktop';
  dpr: number;
  touch: boolean;
  build: string;
  eff: string;
  mem: number;
}

/** The device, parsed on the device (the user agent itself is never sent). */
export function deviceContext(win: Window): DeviceContext {
  const nav = win.navigator as Navigator & { standalone?: boolean; connection?: { effectiveType?: string }; deviceMemory?: number; userAgentData?: unknown };
  const ua = typeof nav?.userAgent === 'string' ? nav.userAgent : '';
  const touch = (nav?.maxTouchPoints ?? 0) > 0;
  let plat: DeviceContext['plat'] = 'other';
  let osv = 0;
  const ios = /iPhone|iPad|iPod/.exec(ua) ?? (/Macintosh/.test(ua) && touch ? ['iPad'] : null);
  if (ios) {
    plat = 'ios';
    osv = Number(/OS (\d+)_/.exec(ua)?.[1] ?? /Version\/(\d+)/.exec(ua)?.[1] ?? 0);
  } else if (/Android/.test(ua)) {
    plat = 'android';
    osv = Number(/Android (\d+)/.exec(ua)?.[1] ?? 0);
  } else if (/Macintosh|Mac OS X/.test(ua)) plat = 'mac';
  else if (/Windows/.test(ua)) plat = 'windows';
  else if (/Linux|CrOS/.test(ua)) plat = 'linux';
  const eng: DeviceContext['eng'] = /Firefox\//.test(ua) ? 'gecko' : /Chrome\/|Chromium\/|Edg\//.test(ua) && plat !== 'ios' ? 'blink' : /AppleWebKit/.test(ua) ? 'webkit' : 'other';
  let sa = nav?.standalone === true;
  try {
    sa = sa || !!win.matchMedia?.('(display-mode: standalone)').matches;
  } catch {
    // keep what navigator said
  }
  const eff = nav?.connection?.effectiveType;
  const mem = nav?.deviceMemory;
  return {
    plat,
    osv: Number.isFinite(osv) ? Math.max(0, Math.min(99, osv)) : 0,
    eng,
    sa,
    lay: layoutOf(win.innerWidth || 0),
    dpr: Math.max(1, Math.min(3, Math.round(win.devicePixelRatio || 1))),
    touch,
    build: buildId(win),
    eff: typeof eff === 'string' && (EFFECTIVE as readonly string[]).includes(eff) ? eff : 'na',
    mem: typeof mem === 'number' && Number.isFinite(mem) ? Math.max(0, Math.min(64, Math.round(mem))) : -1,
  };
}

/** The controlling worker's build id (its `?v=`), or `none`. */
export function buildId(win: Window): string {
  try {
    const url = win.navigator?.serviceWorker?.controller?.scriptURL;
    if (!url) return 'none';
    const v = new URL(url).searchParams.get('v') ?? '';
    return /^[a-z0-9]{1,24}$/.test(v) ? v : 'none';
  } catch {
    return 'none';
  }
}
