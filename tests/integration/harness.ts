// Integration harness (spec §9.3, A17). LOCAL ONLY: tests/helpers/integration-setup.ts has already loaded
// .env.test into process.env and refused non-local Supabase URLs.
//
//   * The server under test is a production build (`npm run build:test`) on http://127.0.0.1:$PORT
//     (PORT from the environment, else .env.test). If nothing listens there, withTestServer() starts
//     `node scripts/with-test-env.mjs next start` for the file, captures its output, checks it for the
//     synthetic PII the file used (spec §9.6 "no PII in logs") and stops it afterwards. A server you started
//     yourself is reused (its logs are checked only when LP_SERVER_LOG names its log file).
//   * Sessions are minted with the .env.test SESSION_SECRET (synthetic identities only); the real sign-in
//     route has its own tests. Every login test uses a unique fake IP and deletes its own attempts.
//   * Direct database access uses the local service-role key (assertions and test setup only).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, openSync, readFileSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, expect } from 'vitest';
import type { RequestSummary } from '@/lib/api-types';
import { SESSION_COOKIE, signSessionToken } from '@/lib/server/session-token';
import { ROOT, assertLocalUrl } from '../../scripts/test-env.mjs';

export const PORT = process.env.PORT || '3100';
export const BASE = `http://127.0.0.1:${PORT}`;
export const ORIGIN = BASE;
export const PASSWORD = process.env.APP_SHARED_PASSWORD as string;

// ---------------------------------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------------------------------

let child: ChildProcess | null = null;
let childLog: string | null = null;
const piiValues = new Set<string>();

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/session`, { signal: AbortSignal.timeout(1_500) });
    return res.status === 401;
  } catch {
    return false;
  }
}

async function startServer(): Promise<void> {
  if (!existsSync(join(ROOT, '.next', 'BUILD_ID'))) {
    throw new Error('No production build: run `npm run build:test` first.');
  }
  childLog = `/tmp/lp-int-server-${PORT}-${process.pid}-${Date.now()}.log`;
  const fd = openSync(childLog, 'w');
  child = spawn(process.execPath, ['scripts/with-test-env.mjs', 'next', 'start', '--hostname', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, PORT },
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (child.exitCode !== null) throw new Error(`next start exited early (code ${child.exitCode}); see ${childLog}`);
    if (await serverUp()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`next start did not come up on ${BASE} within 60 s; see ${childLog}`);
}

async function stopServer(): Promise<void> {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      c.kill('SIGKILL');
      resolve();
    }, 10_000);
    c.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    c.kill('SIGTERM');
  });
}

/** The server log for this file (owned server, or LP_SERVER_LOG), or null when unknown. */
export function serverLogPath(): string | null {
  return childLog ?? process.env.LP_SERVER_LOG ?? null;
}

/** Registers synthetic values that must never appear in the server log. */
export function pii<T extends string>(value: T): T {
  if (value.length >= 4) piiValues.add(value);
  return value;
}

/** Fails if any registered synthetic value appears in the server log. Returns false when no log is known. */
export function assertNoPiiInLogs(): boolean {
  const path = serverLogPath();
  if (!path || !existsSync(path)) return false;
  const log = readFileSync(path, 'utf8');
  for (const value of piiValues) expect(log.includes(value), `server log contains synthetic PII "${value}"`).toBe(false);
  // Every synthetic name, staff member and description the tests create starts with "TEST-S".
  expect(log.includes('TEST-S'), 'server log contains a synthetic test value').toBe(false);
  // The seed's synthetic people and contacts, read by the sync / detail / export tests.
  for (const seedValue of ['Kayla', 'Martinez', 'Maya R.', '(407) 555-0142', 'Dana Kim', 'Pink cowboy hat']) {
    expect(log.includes(seedValue), `server log contains seed value "${seedValue}"`).toBe(false);
  }
  return true;
}

/** Call at the top of a test file: reuse or start the server, and check its log for PII at the end. */
export function withTestServer(): void {
  beforeAll(async () => {
    if (!(await serverUp())) await startServer();
  }, 90_000);
  afterAll(async () => {
    try {
      assertNoPiiInLogs();
    } finally {
      await stopServer();
    }
  }, 30_000);
}

// ---------------------------------------------------------------------------------------------------
// Identities and sessions
// ---------------------------------------------------------------------------------------------------

let counter = 0;
/** A unique token for synthetic names: "s<time><n>". */
export function uniq(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}${randomBytes(2).toString('hex')}`;
}

export interface Staff {
  staffName: string;
  team: string;
}

/** A unique synthetic staff member. */
export function newStaff(team = 'GC/HX - Dispatch'): Staff {
  return { staffName: pii(`TEST-S Staff ${uniq()}`), team };
}

/** The attribution string the server writes for a staff member. */
export function staffOf(s: Staff): string {
  return `${s.staffName} · ${s.team}`;
}

function sessionSecret(): string {
  const s = process.env.SESSION_SECRET?.trim();
  if (!s) throw new Error('.env.test has no SESSION_SECRET');
  return s;
}

/**
 * A Cookie header value for a session minted with the test secret. `issuedAgo` / `firstIssuedAgo`
 * (seconds) backdate the token's iat and its sid (first sign-in time).
 */
export async function cookieFor(staff: Staff, opts: { issuedAgo?: number; firstIssuedAgo?: number } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const iat = now - (opts.issuedAgo ?? 0);
  const sid = opts.firstIssuedAgo !== undefined ? `${now - opts.firstIssuedAgo}.${randomBytes(12).toString('hex')}` : undefined;
  const signed = await signSessionToken({ ...staff, sid }, sessionSecret(), iat);
  if (!signed) throw new Error('could not sign a test session');
  return `${SESSION_COOKIE}=${signed.token}`;
}

// ---------------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------------

export interface ApiResult<T = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

export interface ApiOptions {
  method?: string;
  /** JSON body (serialised, Content-Type application/json). */
  json?: unknown;
  /** Raw body (FormData, string, bytes). */
  body?: BodyInit;
  cookie?: string | null;
  /** Origin header; defaults to the server origin for anything but GET. null = send none. */
  origin?: string | null;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
}

export async function api<T = any>(path: string, opts: ApiOptions = {}): Promise<ApiResult<T>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const method = opts.method ?? (opts.json !== undefined || opts.body !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  const origin = opts.origin === undefined ? (method === 'GET' ? null : ORIGIN) : opts.origin;
  if (origin) headers.origin = origin;
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body, redirect: opts.redirect ?? 'manual' });
  const text = await res.text();
  let parsed: unknown = text;
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, headers: res.headers, body: parsed as T, text };
}

/** Set-Cookie headers of a response. */
export function setCookies(headers: Headers): string[] {
  return headers.getSetCookie();
}

// ---------------------------------------------------------------------------------------------------
// Database (service role, local only)
// ---------------------------------------------------------------------------------------------------

let adminClient: SupabaseClient | null = null;
export function admin(): SupabaseClient {
  if (!adminClient) {
    adminClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL as string, process.env.SUPABASE_SECRET_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return adminClient;
}

let cachedDbUrl: string | null = null;
/** The local Postgres URL (SUPABASE_DB_URL, else `supabase status`), refusing any non-local host. */
export function dbUrl(): string {
  if (cachedDbUrl) return cachedDbUrl;
  let url = process.env.SUPABASE_DB_URL;
  if (!url) {
    const out = execFileSync('supabase', ['status', '-o', 'env'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    url = /^DB_URL="?([^"\n]+)"?$/m.exec(out)?.[1];
  }
  if (!url) throw new Error('Could not find the local database URL (is `supabase start` running?)');
  assertLocalUrl('database URL', url);
  cachedDbUrl = url;
  return url;
}

/** Runs SQL through psql (local only); returns stdout (unaligned, tuples only). */
export function psql(sql: string): string {
  return execFileSync('psql', [dbUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-c', sql], { encoding: 'utf8' }).trim();
}

/** Starts psql with a script and returns the running process (for two-connection timing tests). */
export function psqlAsync(sql: string): { done: Promise<{ code: number | null; out: string }> } {
  const p = spawn('psql', [dbUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-c', sql], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d: Buffer) => (out += d.toString()));
  p.stderr.on('data', (d: Buffer) => (out += d.toString()));
  return { done: new Promise((resolve) => p.on('exit', (code) => resolve({ code, out }))) };
}

/** A unique fake client IP (198.18.0.0/15 benchmark range) with no attempts recorded yet. */
export async function freshIp(): Promise<string> {
  const b = randomBytes(3);
  const ip = `198.${18 + ((b[0] ?? 0) % 2)}.${b[1] ?? 1}.${(b[2] ?? 1) % 254 + 1}`;
  await clearAttempts(ip);
  return ip;
}

export async function clearAttempts(ip: string): Promise<void> {
  const { error } = await admin().from('lp_login_attempts').delete().eq('ip', ip);
  if (error) throw new Error(`could not clear login attempts: ${error.code}`);
}

// ---------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------

/** A minimal valid create body with synthetic values. */
export function createBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const tag = uniq();
  return {
    clientMutationId: randomUUID(),
    reportingLocation: 'FA 3 – Kinetic',
    name: pii(`TEST-S Missing ${tag}`),
    age: 22,
    gender: 'Female',
    clothing: pii(`TEST-S red hoodie ${tag}`),
    contactName: pii(`TEST-S Friend ${tag}`),
    contactPhone: '(407) 555-0100',
    ...extra,
  };
}

/** Creates a request through the API as `staff` and returns the RequestSummary. */
export async function createRequest(staff: Staff, extra: Record<string, unknown> = {}) {
  const res = await api('/api/requests', { json: createBody(extra), cookie: await cookieFor(staff) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.request as RequestSummary;
}

/** Sets a request's status directly in the database (test setup only); returns the new row_version. */
export async function forceStatus(id: string, status: string): Promise<number> {
  const { data, error } = await admin().from('patients').update({ status }).eq('id', id).select('row_version').single();
  if (error) throw new Error(`forceStatus failed: ${error.code} ${error.message}`);
  return Number((data as { row_version: number }).row_version);
}

export async function rowVersion(id: string): Promise<number> {
  const { data, error } = await admin().from('patients').select('row_version').eq('id', id).single();
  if (error) throw new Error(`rowVersion failed: ${error.code}`);
  return Number((data as { row_version: number }).row_version);
}

export { randomUUID };
