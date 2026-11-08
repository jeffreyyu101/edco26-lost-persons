// Network (design §4.3): resource timing plus a pass-through fetch observer. WebKit (most staff phones) gives no
// responseStatus and no entry at all for a failed or aborted fetch, so the collector also watches window.fetch: the
// app's request starts first, unchanged, and the observer hands back THE SAME promise object (no wrapping, no delay,
// no extra await); it never reads a body or a header and never clones the response. Same-origin /api/ paths only,
// never /api/telemetry. Resource entries add bytes and the requests made before the collector loaded; the buffer is
// never cleared (lib/client/sw-client.ts collectAssetUrls reads it for the offline precache).
import { TEL_PATH } from '../../telemetry';
import { abortKind } from './detect';
import { pathPattern } from './sanitize';

export type NetStatus = '2xx' | '4xx' | '401' | '409' | '429' | '5xx' | 'net' | 'timeout' | 'abort' | 'unk';

export interface NetStart {
  id: number;
  pattern: string;
  /** The path as requested (in memory only: flows match their request on the device; never sent). */
  path: string;
  method: string;
  t: number;
}

export interface NetEnd extends NetStart {
  st: NetStatus;
  end: number;
}

export interface NetHooks {
  now(): number;
  origin: string;
  start(req: NetStart): void;
  end(req: NetEnd): void;
  fault(): void;
}

/** A response's status class, as lib/client/http.ts reads it (a redirect, 511 or 0 is the network: a captive portal). */
export function statusOf(res: { status: number; redirected?: boolean }): NetStatus {
  const s = res.status;
  if (res.redirected || s === 511 || s === 0) return 'net';
  if (s >= 200 && s < 300) return '2xx';
  if (s === 401 || s === 409 || s === 429) return String(s) as NetStatus;
  if (s >= 400 && s < 500) return '4xx';
  if (s >= 500) return '5xx';
  return 'unk';
}

function urlOf(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const u = input as { href?: unknown; url?: unknown };
    if (typeof u.href === 'string') return u.href;
    if (typeof u.url === 'string') return u.url;
  }
  return null;
}

function methodOf(input: unknown, init: RequestInit | undefined): string {
  const m = init?.method ?? (input && typeof input === 'object' ? (input as { method?: unknown }).method : undefined);
  return (typeof m === 'string' ? m : 'GET').toLowerCase();
}

export interface FetchObserver {
  inflight(): number;
  /** Restores the page's fetch, only when it is still ours. */
  stop(): void;
}

/** Installs the observer on `target.fetch`. */
export function observeFetch(target: { fetch: typeof fetch }, hooks: NetHooks): FetchObserver {
  const native = target.fetch;
  const bound = native.bind(target);
  let inflight = 0;
  let seq = 0;
  const watch = (input: unknown, init: RequestInit | undefined, promise: Promise<Response>) => {
    const url = urlOf(input);
    if (!url) return;
    let path: string;
    try {
      path = new URL(url, hooks.origin).pathname;
    } catch {
      return;
    }
    if (path === TEL_PATH || path.startsWith(`${TEL_PATH}/`)) return;
    const pattern = pathPattern(url, hooks.origin);
    if (!pattern) return;
    const req: NetStart = { id: (seq += 1), pattern, path, method: methodOf(input, init), t: hooks.now() };
    inflight += 1;
    hooks.start(req);
    const done = (st: NetStatus) => {
      inflight = Math.max(0, inflight - 1);
      try {
        hooks.end({ ...req, st, end: hooks.now() });
      } catch {
        hooks.fault();
      }
    };
    // Our own chain: it handles the rejection for itself only (the app's handlers still get it) and never throws.
    promise.then(
      (res) => {
        try {
          done(statusOf(res));
        } catch {
          hooks.fault();
        }
      },
      (error: unknown) => {
        try {
          const name = (error as { name?: unknown } | null)?.name;
          done(name === 'AbortError' ? abortKind(req.pattern, req.method, hooks.now() - req.t) : 'net');
        } catch {
          hooks.fault();
        }
      },
    );
  };
  const observed = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const promise = bound(input, init);
    try {
      watch(input, init, promise);
    } catch {
      hooks.fault();
    }
    return promise;
  } as typeof fetch;
  target.fetch = observed;
  return {
    inflight: () => inflight,
    stop: () => {
      if (target.fetch === observed) target.fetch = native;
    },
  };
}

/** The parts of a resource timing entry read here. */
export interface ResourceEntry {
  name: string;
  startTime: number;
  duration: number;
  responseEnd?: number;
  transferSize?: number;
  responseStatus?: number;
}

/** A resource entry for an /api/ path (not telemetry), as its pattern, or null. */
export function apiEntry(entry: ResourceEntry, origin: string): { pattern: string; st: NetStatus } | null {
  let path: string;
  try {
    path = new URL(entry.name, origin).pathname;
  } catch {
    return null;
  }
  if (path === TEL_PATH || path.startsWith(`${TEL_PATH}/`)) return null;
  const pattern = pathPattern(entry.name, origin);
  if (!pattern) return null;
  const s = entry.responseStatus;
  return { pattern, st: typeof s === 'number' && s > 0 ? statusOf({ status: s }) : 'unk' };
}
