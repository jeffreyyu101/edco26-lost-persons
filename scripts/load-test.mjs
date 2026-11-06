#!/usr/bin/env node
// Load check (spec §9.7): N simulated phones polling GET /api/sync like the real client — one full fetch
// (paged), then a delta poll every 6 s ± 1 s with the database cursor, reconcile=1 on every 10th poll and
// a 12 s timeout — for a fixed duration, against the LOCAL production build. Reports p50 / p95 / p99 / max
// latency, bytes per poll and errors; exits 1 on any error.
//
//   npm run build:test && PORT=3101 npm run start:test        # in another terminal
//   PORT=3101 node scripts/load-test.mjs                      # 30 clients, 120 s
//   PORT=3101 node scripts/load-test.mjs --clients 10 --seconds 30 --writes
//
// --writes adds one synthetic writer (a request every 10 s, then an answer), so deltas carry rows.
// LOCAL ONLY: refuses any host but 127.0.0.1 / localhost. Synthetic identities only ("TEST-load …").
import { randomUUID } from 'node:crypto';
import { assertLocalUrl, loadTestEnv } from './test-env.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const env = loadTestEnv();
const CLIENTS = Number(arg('clients', 30));
const SECONDS = Number(arg('seconds', 120));
const WRITES = arg('writes', false) === true;
const BASE = process.env.LOAD_BASE_URL || `http://127.0.0.1:${process.env.PORT || env.PORT || '3100'}`;
assertLocalUrl('load-test target', BASE);
const PASSWORD = env.APP_SHARED_PASSWORD;
if (!PASSWORD) throw new Error('.env.test has no APP_SHARED_PASSWORD');

const POLL_MS = 6_000;
const JITTER_MS = 1_000;
const TIMEOUT_MS = 12_000;
const RECONCILE_EVERY = 10;
const RUN_TAG = Date.now().toString(36);

const samples = []; // {kind, ms, ok, status, bytes}
const errors = new Map(); // "kind status" -> count

function record(kind, started, res, bytes, failure) {
  const ms = performance.now() - started;
  const ok = !failure && res !== null && res.status >= 200 && res.status < 300;
  samples.push({ kind, ms, ok, bytes });
  if (!ok) {
    const key = `${kind} ${failure ?? res?.status}`;
    errors.set(key, (errors.get(key) ?? 0) + 1);
  }
}

async function timedFetch(kind, path, init = {}) {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    record(kind, started, res, text.length);
    return { res, text };
  } catch (error) {
    record(kind, started, null, 0, error?.name === 'TimeoutError' ? 'timeout' : `network:${error?.cause?.code ?? error?.name ?? 'unknown'}`);
    return null;
  }
}

async function signIn(n) {
  const res = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: {
      origin: BASE,
      'content-type': 'application/json',
      // A distinct fake IP per simulated phone (198.18.0.0/15 benchmark range): no shared limit.
      'x-real-ip': `198.19.${200 + Math.floor(n / 250)}.${(n % 250) + 1}`,
    },
    body: JSON.stringify({ staffName: `TEST-load ${RUN_TAG} ${n}`, team: 'Medical', password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`sign-in for client ${n} failed: HTTP ${res.status}`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lp_session='));
  if (!cookie) throw new Error('no session cookie');
  return cookie.split(';')[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Sleeps, but never past the deadline. */
const sleepUntil = (ms, deadline) => sleep(Math.max(0, Math.min(ms, deadline - performance.now())));

/** One simulated phone: full fetch (paged), then delta polls until the deadline. */
async function client(n, deadline) {
  const cookie = await signIn(n);
  const headers = { cookie };
  await sleep(Math.random() * POLL_MS);
  let cursor = null;
  let polls = 0;
  while (performance.now() < deadline) {
    polls += 1;
    const reconcile = cursor !== null && polls % RECONCILE_EVERY === 0;
    const kind = cursor === null ? 'full' : reconcile ? 'reconcile' : 'delta';
    let after = null;
    let firstServerTime = null;
    let failed = false;
    for (let page = 0; page < 100; page += 1) {
      const params = new URLSearchParams();
      if (cursor) params.set('since', cursor);
      if (reconcile) params.set('reconcile', '1');
      if (after) {
        params.set('afterAt', after.at);
        params.set('afterId', after.id);
      }
      const qs = params.toString();
      const out = await timedFetch(kind, qs ? `/api/sync?${qs}` : '/api/sync', { headers });
      if (!out || out.res.status !== 200) {
        failed = true;
        break;
      }
      const body = JSON.parse(out.text);
      firstServerTime ??= body.serverTime;
      if (!body.hasMore) break;
      after = body.next;
    }
    if (!failed) cursor = firstServerTime;
    await sleepUntil(POLL_MS - JITTER_MS + Math.random() * 2 * JITTER_MS, deadline);
  }
}

/** Optional writer: a synthetic request every 10 s, answered "Not in medical" right after. */
async function writer(deadline) {
  const cookie = await signIn(CLIENTS + 1);
  const headers = { cookie, origin: BASE, 'content-type': 'application/json' };
  let i = 0;
  while (performance.now() < deadline) {
    i += 1;
    const created = await timedFetch('write', '/api/requests', {
      method: 'POST',
      headers,
      body: JSON.stringify({ clientMutationId: randomUUID(), reportingLocation: 'Base', name: `TEST-load ${RUN_TAG} ${i}`, clothing: 'TEST-load' }),
    });
    if (created?.res.status === 201) {
      const { request } = JSON.parse(created.text);
      await timedFetch('write', `/api/requests/${request.id}/status`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ status: 'Checked – Not Found', expectedVersion: request.rowVersion, kind: 'answer' }),
      });
    }
    await sleepUntil(10_000, deadline);
  }
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function summary(kind) {
  const list = samples.filter((s) => kind === 'all' || s.kind === kind);
  const ms = list.map((s) => s.ms).sort((a, b) => a - b);
  const bytes = list.reduce((n, s) => n + s.bytes, 0);
  return {
    kind,
    requests: list.length,
    errors: list.filter((s) => !s.ok).length,
    p50: Math.round(pct(ms, 50)),
    p95: Math.round(pct(ms, 95)),
    p99: Math.round(pct(ms, 99)),
    max: Math.round(ms[ms.length - 1] ?? 0),
    avgBytes: list.length ? Math.round(bytes / list.length) : 0,
  };
}

console.log(`load-test: ${CLIENTS} clients polling ${BASE}/api/sync for ${SECONDS}s${WRITES ? ' + 1 writer' : ''}`);
const deadline = performance.now() + SECONDS * 1000;
const started = Date.now();
const results = await Promise.allSettled([
  ...Array.from({ length: CLIENTS }, (_, n) => client(n, deadline)),
  ...(WRITES ? [writer(deadline)] : []),
]);
const crashed = results.filter((r) => r.status === 'rejected');
for (const r of crashed) console.error(`load-test: a client stopped: ${r.reason?.message ?? r.reason}`);

const rows = ['full', 'delta', 'reconcile', ...(WRITES ? ['write'] : []), 'all'].map(summary);
console.table(rows);
const elapsed = (Date.now() - started) / 1000;
const all = rows[rows.length - 1];
console.log(`load-test: ${all.requests} requests in ${elapsed.toFixed(1)}s (${(all.requests / elapsed).toFixed(1)} req/s)`);
if (errors.size) console.log('load-test: errors by kind/status:', Object.fromEntries(errors));
const failed = all.errors > 0 || crashed.length > 0;
console.log(`load-test: ${failed ? 'FAIL' : 'PASS'} (p50 ${all.p50} ms, p95 ${all.p95} ms, errors ${all.errors})`);
process.exit(failed ? 1 : 0);
