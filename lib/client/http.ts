// The store's only door to the API (screens never call fetch). Every call has a timeout, never throws,
// and classifies the outcome so the sync loop, mutations and the outbox can decide what is definitive.
// Never logs anything (no PII in the console).
import type { ApiError } from '../api-types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpFailure =
  /** The server answered with an error status. `error` is the parsed {error} body, or null when it wasn't ours. */
  | { ok: false; kind: 'http'; status: number; error: ApiError['error'] | null }
  /** No answer: offline, DNS, reset, or a captive portal / proxy that answered with something that isn't our API. */
  | { ok: false; kind: 'network' }
  | { ok: false; kind: 'timeout' };

export type HttpResult<T> = { ok: true; status: number; data: T } | HttpFailure;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  json?: unknown;
  form?: FormData;
  timeoutMs: number;
  /** Aborts the call (store stopped / logged out); reported as a network failure. */
  signal?: AbortSignal;
}

function isApiError(value: unknown): value is ApiError {
  const e = (value as ApiError | null)?.error;
  return !!e && typeof e === 'object' && typeof e.code === 'string' && typeof e.message === 'string';
}

export async function apiRequest<T>(fetchFn: FetchLike, path: string, opts: RequestOptions): Promise<HttpResult<T>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      body = opts.form;
    }
    const res = await fetchFn(path, {
      method: opts.method ?? 'GET',
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    // A captive portal (festival Wi-Fi) redirects or answers 511; neither is our API.
    if (res.redirected || res.status === 511 || res.status === 0) return { ok: false, kind: 'network' };
    let parsed: unknown = undefined;
    let parsedOk = false;
    try {
      const text = await res.text();
      parsed = text ? (JSON.parse(text) as unknown) : null;
      parsedOk = true;
    } catch {
      parsedOk = false;
    }
    if (res.ok) {
      // A 2xx that isn't JSON came from something in between (portal, proxy), not from us.
      if (!parsedOk || parsed === null || typeof parsed !== 'object') return { ok: false, kind: 'network' };
      return { ok: true, status: res.status, data: parsed as T };
    }
    return { ok: false, kind: 'http', status: res.status, error: parsedOk && isApiError(parsed) ? parsed.error : null };
  } catch {
    return timedOut ? { ok: false, kind: 'timeout' } : { ok: false, kind: 'network' };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Network failure, timeout or 5xx: the outcome is unknown, retry with the same ids. */
export function isUncertain(res: HttpFailure): boolean {
  return res.kind !== 'http' || res.status >= 500 || res.status === 408 || res.status === 425 || res.status === 429;
}

/**
 * A definitive rejection: one of `statuses`, AND the body is our {error} JSON (so an HTML 404 from a portal
 * never discards a queued request).
 */
export function isDefinitive(res: HttpFailure, statuses: ReadonlySet<number>): boolean {
  return res.kind === 'http' && statuses.has(res.status) && res.error !== null;
}
