// Request / response helpers for the route handlers (spec §6 "Every route"). Server only.
import 'server-only';
import type { z } from 'zod';
import { idParamsSchema } from '../validation';
import { ApiFailure } from './errors';

/** JSON bodies over 64 KB are refused (spec §6). */
export const JSON_BODY_LIMIT = 64 * 1024;

export const NO_STORE = 'no-store';

/** A JSON response with Cache-Control: no-store. */
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': NO_STORE, ...headers },
  });
}

/** First value of a comma-separated header, trimmed and lowercased; null when absent / blank. */
function firstValue(value: string | null): string | null {
  const v = value?.split(',')[0]?.trim().toLowerCase();
  return v ? v : null;
}

/** The request protocol: x-forwarded-proto (set by Vercel / the Next server), else the URL. */
export function requestProtocol(request: Request): 'http' | 'https' {
  const forwarded = firstValue(request.headers.get('x-forwarded-proto'));
  if (forwarded === 'https' || forwarded === 'http') return forwarded;
  try {
    return new URL(request.url).protocol === 'https:' ? 'https' : 'http';
  } catch {
    return 'http';
  }
}

/** A16: the session cookie is Secure whenever the request came in over https. */
export function isHttps(request: Request): boolean {
  return requestProtocol(request) === 'https';
}

function originOf(proto: string, host: string | null): string | null {
  if (!host || /[\s/\\@?#]/.test(host)) return null;
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

/**
 * The origins this request may legitimately come from: `proto://x-forwarded-host` and `proto://host`
 * (Vercel sets x-forwarded-host / x-forwarded-proto; locally the Next server does).
 */
export function expectedOrigins(request: Request): string[] {
  const proto = requestProtocol(request);
  const out = new Set<string>();
  for (const host of [firstValue(request.headers.get('x-forwarded-host')), firstValue(request.headers.get('host'))]) {
    const origin = originOf(proto, host);
    if (origin) out.add(origin);
  }
  return [...out];
}

/** Mutations require same-origin (spec §6): the Origin header must equal the request origin, else 403. */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') throw new ApiFailure('bad_origin');
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    throw new ApiFailure('bad_origin');
  }
  if (normalized === 'null' || !expectedOrigins(request).includes(normalized)) throw new ApiFailure('bad_origin');
}

/**
 * Reads a request body up to `limit` bytes. A declared or actual size over the limit → 413 too_large
 * (the stream is cancelled; the rest is never buffered).
 */
export async function readBodyLimited(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > limit) throw new ApiFailure('too_large');
  if (!request.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await reader.read();
    } catch {
      throw new ApiFailure('bad_request', 'Could not read the request');
    }
    if (step.done) break;
    total += step.value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ApiFailure('too_large');
    }
    chunks.push(step.value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The camelCase field a zod issue points at ("patch.name" → "name"). */
function issueField(path: ReadonlyArray<PropertyKey>): string | undefined {
  const parts = path.filter((p): p is string => typeof p === 'string');
  const field = parts[0] === 'patch' ? parts[1] : parts[0];
  return field && /^[A-Za-z][A-Za-z0-9]{0,59}$/.test(field) ? field : undefined;
}

/** Turns a zod failure into a 422 invalid with the first offending field. */
export function invalidFromZod(error: z.ZodError): ApiFailure {
  const issue = error.issues[0];
  const field = issue ? issueField(issue.path) : undefined;
  const message = issue?.message ? issue.message.slice(0, 160) : undefined;
  return new ApiFailure('invalid', message, { extra: field ? { field } : {} });
}

/**
 * Reads a JSON body (≤ 64 KB) and validates it. Malformed JSON → 400 bad_request; a schema failure →
 * 422 invalid with `field`.
 */
export async function readJson<S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S>> {
  const bytes = await readBodyLimited(request, JSON_BODY_LIMIT);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ApiFailure('bad_request', 'Body must be JSON');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidFromZod(parsed.error);
  return parsed.data;
}

/** Parses a query string with a schema; failure → 400 bad_request (with the field when known). */
export function parseQuery<S extends z.ZodType>(params: URLSearchParams, schema: S): z.output<S> {
  const raw: Record<string, string> = {};
  params.forEach((value, key) => {
    raw[key] = value;
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue ? issueField(issue.path) : undefined;
    throw new ApiFailure('bad_request', 'Bad query', { extra: field ? { field } : {} });
  }
  return parsed.data;
}

/** The `:id` route param: a UUID (lowercased), else 404 not_found (an id that cannot exist). */
export function idParam(params: Record<string, unknown>): string {
  const parsed = idParamsSchema.safeParse({ id: params.id });
  if (!parsed.success) throw new ApiFailure('not_found');
  return parsed.data.id.toLowerCase();
}

const IP_PATTERN = /^[0-9a-f:.]{2,45}$/i;

function ipFrom(value: string | null, which: 'first' | 'single'): string | null {
  if (!value) return null;
  const candidate = (which === 'first' ? value.split(',')[0] : value)?.trim().toLowerCase() ?? '';
  return IP_PATTERN.test(candidate) ? candidate : null;
}

/**
 * The client IP for sign-in rate limiting (spec §6): x-vercel-forwarded-for, then x-real-ip, then the
 * leftmost x-forwarded-for, then "0.0.0.0". Vercel's edge sets the first two, so on Vercel a client
 * cannot choose its IP through x-forwarded-for.
 */
export function clientIp(headers: Headers): string {
  return (
    ipFrom(headers.get('x-vercel-forwarded-for'), 'first') ??
    ipFrom(headers.get('x-real-ip'), 'first') ??
    ipFrom(headers.get('x-forwarded-for'), 'first') ??
    '0.0.0.0'
  );
}
