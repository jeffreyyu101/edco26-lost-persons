// Telemetry against the real routes and the local database (design §3 and §6 Integration): POST /api/telemetry (auth,
// origin, caps on size, validation, the team from the session, skew, dedupe, the per-device-hour caps, 204 when off
// with nothing written, no cookie re-issue), the kill switch route, GET /api/telemetry/health, the SQL (RLS with no
// policies, privileges, exactly one retention job, retention itself, the standalone paste) and the Health aggregates.
// Synthetic devices and staff only; every row this file writes uses a `ti…` device id and is deleted at the end.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { telemetryPaste } from '../../scripts/telemetry-sql.mjs';
import { api, cookieFor, dbUrl, newStaff, psql, setCookies, uniq, withTestServer } from './harness';

withTestServer();

const ctx = { plat: 'ios', osv: 18, eng: 'webkit', sa: true, lay: 'phone', dpr: 3, touch: true, build: 'none', eff: 'na', mem: -1 };
const device = () => `ti${uniq().replace(/[^a-z0-9]/g, '').slice(0, 14)}`.padEnd(16, '0').slice(0, 16);
const batchId = () => `b${uniq().replace(/[^a-z0-9]/g, '')}`.slice(0, 20).padEnd(10, '0');

function batch(d: string, ev: unknown[], over: Record<string, unknown> = {}) {
  return { v: 1, b: batchId(), d, s: 'sessint001', sent: Date.now(), ctx, ev, ...over };
}

const post = async (body: unknown, cookie: string | null, extra: { origin?: string | null; type?: string; raw?: BodyInit } = {}) =>
  api('/api/telemetry', {
    method: 'POST',
    cookie,
    origin: extra.origin,
    body: extra.raw ?? JSON.stringify(body),
    headers: { 'content-type': extra.type ?? 'application/json' },
  });

const rows = (d: string, cols = 'name') => psql(`select coalesce(string_agg(${cols}, ',' order by id), '') from public.lp_tel_events where device = '${d}'`);
const setSettings = (sql: string) => psql(`update public.lp_tel_settings set ${sql}, updated_at = now()`);

let medic: string;
let dispatcher: string;

beforeAll(async () => {
  medic = await cookieFor(newStaff('Medical'));
  dispatcher = await cookieFor(newStaff('GC/HX - Dispatch'));
  setSettings(`enabled = true, off_at = timestamptz '2026-11-10 06:00:00-05', device_hour_cap = 3000, device_hour_bytes = 2097152`);
  // Collection must be on in the server's cache (it may have read "off" in an earlier file).
  await api('/api/telemetry/settings', { json: { enabled: true }, cookie: medic });
});

afterAll(async () => {
  setSettings(`enabled = true, off_at = timestamptz '2026-11-10 06:00:00-05', device_hour_cap = 3000, device_hour_bytes = 2097152`);
  await api('/api/telemetry/settings', { json: { enabled: true }, cookie: medic });
  psql(`delete from public.lp_tel_events where device like 'ti%'; delete from public.lp_tel_devices where device like 'ti%';
        delete from public.lp_tel_quota where device like 'ti%'; delete from public.lp_tel_batches where device like 'ti%'`);
});

describe('POST /api/telemetry', () => {
  it('401 without a session, 403 with another origin', async () => {
    const d = device();
    expect((await post(batch(d, [{ n: 'view', at: Date.now() }]), null)).status).toBe(401);
    expect((await post(batch(d, [{ n: 'view', at: Date.now() }]), medic, { origin: 'https://evil.example' })).status).toBe(403);
    expect(rows(d)).toBe('');
  });

  it('a hidden iPhone page’s beacon (Origin: null): accepted only with Sec-Fetch-Site same-origin', async () => {
    const d = device();
    const beacon = (site: string) =>
      api('/api/telemetry', { method: 'POST', cookie: medic, origin: 'null', body: JSON.stringify(batch(d, [{ n: 'vis', at: Date.now(), ok: false }])), headers: { 'content-type': 'text/plain;charset=UTF-8', 'sec-fetch-site': site } });
    expect((await beacon('cross-site')).status).toBe(403);
    expect((await beacon('same-origin')).status).toBe(200);
    expect(rows(d)).toBe('vis');
  });

  it('stores a batch: the team from the session (never the body), the device context, and 200 with the settings', async () => {
    const d = device();
    const res = await post({ ...batch(d, [{ n: 'view', at: Date.now(), v: 'pending', p: { from: 'all', lay: 'phone', filter: 'none' } }]), team: 'medical' }, dispatcher);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ on: true, until: Date.parse('2026-11-10T11:00:00Z'), flushSeconds: 60, sample: 1, rejected: 0 });
    expect(typeof res.body.now).toBe('number');
    expect(rows(d, "name || ':' || team || ':' || view")).toBe('view:dispatch:pending');
    expect(psql(`select plat || ':' || sa || ':' || build || ':' || team from public.lp_tel_devices where device = '${d}'`)).toBe('ios:true:none:dispatch');
  });

  it('a custom team text is other; no Set-Cookie on any answer, even for a token that would be re-issued', async () => {
    const d = device();
    const old = await cookieFor(newStaff('TEST-S Custom Crew'), { issuedAgo: 2 * 3_600 });
    const res = await post(batch(d, [{ n: 'view', at: Date.now() }]), old);
    expect(res.status).toBe(200);
    expect(setCookies(res.headers)).toEqual([]);
    expect(rows(d, 'team')).toBe('other');
  });

  it('gzip bodies; 413 over 48 KB on the wire and for a gzip that inflates past 256 KB; 422 for a bad envelope', async () => {
    const d = device();
    const gz = gzipSync(JSON.stringify(batch(d, [{ n: 'view', at: Date.now() }])));
    expect((await post(null, medic, { raw: gz, type: 'application/x-lp-tel+gzip' })).status).toBe(200);
    expect((await post(null, medic, { raw: 'x'.repeat(49 * 1024) })).status).toBe(413);
    const bomb = gzipSync(Buffer.alloc(2 * 1024 * 1024, 32));
    expect((await post(null, medic, { raw: bomb, type: 'application/x-lp-tel+gzip' })).status).toBe(413);
    expect((await post({ ...batch(d, [{ n: 'view', at: Date.now() }]), v: 9 }, medic)).status).toBe(422);
    expect((await post({ ...batch(d, [{ n: 'view', at: Date.now() }]), d: 'Not A Device' }, medic)).status).toBe(422);
    expect(rows(d)).toBe('view');
  });

  it('one bad event among good ones: the rest are stored and rejected = 1; a trail only on frustration', async () => {
    const d = device();
    const now = Date.now();
    const res = await post(
      batch(d, [
        { n: 'view', at: now },
        { n: 'tap', at: now, a: 'Quorra Zyxwvut', c: 'x' },
        { n: 'rage_tap', at: now, a: 'thread', c: 'composer-send', k: 3, tr: [[-1200, 'v>profile'], [-200, 't:thread/composer-send']] },
      ]),
      medic,
    );
    expect(res.body.rejected).toBe(1);
    expect(rows(d)).toBe('view,rage_tap');
    expect(psql(`select trail::text from public.lp_tel_events where device = '${d}' and name = 'rage_tap'`)).toBe('[[-1200, "v>profile"], [-200, "t:thread/composer-send"]]');
  });

  it('the phone’s clock is corrected by the skew (sent vs the server clock)', async () => {
    const d = device();
    const sent = Date.now() - 3_600_000;
    await post({ ...batch(d, [{ n: 'view', at: sent - 1_000 }]), sent }, medic);
    const lag = Number(psql(`select round(extract(epoch from (now() - at))) from public.lp_tel_events where device = '${d}'`));
    expect(lag).toBeLessThan(30);
  });

  it('the same batch twice is stored once', async () => {
    const d = device();
    const b = batch(d, [{ n: 'view', at: Date.now() }]);
    expect((await post(b, medic)).status).toBe(200);
    expect((await post(b, medic)).status).toBe(200);
    expect(rows(d)).toBe('view');
  });

  it('the per-device-hour caps: 60 events at a cap of 50 store 50 (capped); a byte cap stores none', async () => {
    setSettings('device_hour_cap = 50');
    try {
      const d = device();
      const ev = Array.from({ length: 60 }, () => ({ n: 'view', at: Date.now() }));
      const res = await post(batch(d, ev), medic);
      expect(res.body).toMatchObject({ on: true, capped: true });
      expect(Number(psql(`select count(*) from public.lp_tel_events where device = '${d}'`))).toBe(50);
    } finally {
      setSettings('device_hour_cap = 3000');
    }
    setSettings('device_hour_bytes = 10');
    try {
      const d = device();
      const res = await post(batch(d, [{ n: 'view', at: Date.now() }]), medic);
      expect(res.body.capped).toBe(true);
      expect(rows(d)).toBe('');
    } finally {
      setSettings('device_hour_bytes = 2097152');
    }
  });

  it('the kill switch: 204 and nothing written (the next ones without a database call); back on through the switch route', async () => {
    const d = device();
    setSettings('enabled = false');
    const first = await post(batch(d, [{ n: 'view', at: Date.now() }]), medic);
    expect(first.status).toBe(204);
    const again = await post(batch(d, [{ n: 'view', at: Date.now() }]), medic);
    expect(again.status).toBe(204);
    expect(rows(d)).toBe('');
    // lp_tel_ingest itself says off and writes nothing.
    expect(psql(`set role service_role; select public.lp_tel_ingest('direct00001', '${d}', 'sessint001', 'medical', 0, '{}', '[{"n":"view","at":1}]', 10)::text`)).toBe('{"on": false}');
    expect(rows(d)).toBe('');
    const on = await api('/api/telemetry/settings', { json: { enabled: true }, cookie: medic });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ on: true, enabled: true });
    expect((await post(batch(d, [{ n: 'view', at: Date.now() }]), medic)).status).toBe(200);
    expect(rows(d)).toBe('view');
  });

  it('past off_at: 204 and nothing written', async () => {
    const d = device();
    setSettings(`off_at = now() - interval '1 minute'`);
    try {
      expect((await post(batch(d, [{ n: 'view', at: Date.now() }]), medic)).status).toBe(204);
      expect(rows(d)).toBe('');
    } finally {
      setSettings(`off_at = timestamptz '2026-11-10 06:00:00-05'`);
      await api('/api/telemetry/settings', { json: { enabled: true }, cookie: medic });
    }
  });

  it('the switch route records tel_switch (team only) and needs a session', async () => {
    expect((await api('/api/telemetry/settings', { json: { enabled: false }, cookie: null })).status).toBe(401);
    const before = Number(psql(`select count(*) from public.lp_tel_events where name = 'tel_switch' and team = 'dispatch'`));
    const res = await api('/api/telemetry/settings', { json: { enabled: true }, cookie: dispatcher });
    expect(res.status).toBe(200);
    expect(Number(psql(`select count(*) from public.lp_tel_events where name = 'tel_switch' and team = 'dispatch'`))).toBe(before + 1);
    psql(`delete from public.lp_tel_events where name = 'tel_switch' and device = 'server' and received_at > now() - interval '1 minute'`);
  });
});

describe('GET /api/telemetry/health and the aggregates', () => {
  it('seeded rows: problems ranked by devices then count, flows p50 / p95, net failure rates by state, errors by fingerprint', async () => {
    const area = `tiarea${uniq().replace(/[^a-z0-9]/g, '').slice(0, 10)}`;
    const ins = (d: string, name: string, extra: string) =>
      `insert into public.lp_tel_events (at, device, session, team, name, view, area, ctl, ms, n, ok, props) values (now(), '${d}', 'sessint001', 'medical', '${name}', ${extra});`;
    const d1 = device();
    const d2 = device();
    const d3 = device();
    psql(
      [
        // A: 3 events on 1 device. B: 2 events on 2 devices (ranks first: devices before count).
        ins(d1, 'rage_tap', `'pending', '${area}-a', 'check-card', null, 3, null, '{"ptr":"touch"}'`),
        ins(d1, 'rage_tap', `'pending', '${area}-a', 'check-card', null, 3, null, '{"ptr":"touch"}'`),
        ins(d1, 'rage_tap', `'pending', '${area}-a', 'check-card', null, 3, null, '{"ptr":"touch"}'`),
        ins(d2, 'stuck_scroll', `'profile', '${area}-b', null, null, 3, null, '{"dir":"up"}'`),
        ins(d3, 'stuck_scroll', `'profile', '${area}-b', null, null, 3, null, '{"dir":"up"}'`),
        ins(d1, 'net', `null, '/api/ti-${area}', null, null, 10, null, '{"m":"get","st":"2xx","on":true,"conn":"live","d":[100,200,300]}'`),
        ins(d1, 'net', `null, '/api/ti-${area}', null, null, 5, null, '{"m":"get","st":"timeout","on":false,"conn":"offline"}'`),
        ins(d1, 'error', `'profile', 'chunk:${area.slice(0, 8)}', 'typeerror', null, 2, null, '{"type":"typeerror","kind":"error","fp":"tifp0001","line":1,"col":42}'`),
      ].join('\n'),
    );
    const res = await api('/api/telemetry/health?window=1h', { cookie: medic });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(res.body).sort()).toEqual(['coverage', 'config', 'errors', 'examples', 'flows', 'generatedAt', 'kpis', 'net', 'problems', 'push', 'window'].sort());
    const mine = (res.body.problems as Array<{ area: string; n: number; devices: number }>).filter((p) => p.area.startsWith(area));
    expect(mine.map((p) => [p.area, p.n, p.devices])).toEqual([
      [`${area}-b`, 2, 2],
      [`${area}-a`, 3, 1],
    ]);
    const net = (res.body.net.rows as Array<{ pattern: string; n: number; failed: number; timeouts: number; p50: number; states: Record<string, { n: number; failed: number }> }>).find((r) => r.pattern === `/api/ti-${area}`);
    expect(net).toMatchObject({ n: 15, failed: 5, timeouts: 5, p50: 200, states: { live: { n: 10, failed: 0 }, link_down: { n: 5, failed: 5 } } });
    expect((res.body.errors as Array<{ fp: string; n: number }>).find((e) => e.fp === 'tifp0001')).toMatchObject({ n: 2, type: 'typeerror' });
    expect(res.body.kpis.devices).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(res.body.coverage)).toBe(true);
  });

  it('needs a session', async () => {
    expect((await api('/api/telemetry/health')).status).toBe(401);
  });
});

describe('the SQL', () => {
  it('RLS on for all five tables, no policies, no privileges for anon / authenticated', () => {
    expect(psql(`select string_agg(relname || ':' || relrowsecurity, ',' order by relname) from pg_class where relname like 'lp\\_tel\\_%' and relkind = 'r'`)).toBe(
      'lp_tel_batches:true,lp_tel_devices:true,lp_tel_events:true,lp_tel_quota:true,lp_tel_settings:true',
    );
    expect(psql(`select count(*) from pg_policies where tablename like 'lp\\_tel\\_%'`)).toBe('0');
    expect(psql(`select count(*) from pg_class c where c.relname like 'lp\\_tel\\_%' and c.relkind = 'r' and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))`)).toBe('0');
  });

  it('the functions are executable by service_role only', () => {
    expect(
      psql(`select string_agg(distinct has_function_privilege('service_role', p.oid, 'execute')::text || '/' || has_function_privilege('anon', p.oid, 'execute')::text || '/' || has_function_privilege('authenticated', p.oid, 'execute')::text, ',')
            from pg_proc p where p.proname like 'lp\\_tel\\_%'`),
    ).toBe('true/false/false');
    expect(psql(`select count(*) from pg_proc where proname like 'lp\\_tel\\_%'`)).toBe('6');
  });

  it('exactly one lp-tel-retention job (daily 09:17 UTC), and retention deletes after 30 days only', () => {
    expect(psql(`select count(*) || '|' || min(schedule) || '|' || min(command) from cron.job where jobname = 'lp-tel-retention'`)).toBe('1|17 9 * * *|select public.lp_tel_retention()');
    const d = device();
    psql(`insert into public.lp_tel_events (at, device, session, team, name) values (now() - interval '31 days', '${d}', 'sessint001', 'medical', 'view'), (now() - interval '29 days', '${d}', 'sessint001', 'medical', 'vis')`);
    psql(`select public.lp_tel_retention()`);
    expect(rows(d)).toBe('vis');
  });

  it('the standalone paste (scripts/telemetry-sql.mjs): the dry run changes nothing, the commit applies twice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lp-tel-sql-'));
    try {
      writeFileSync(join(dir, 'dry.sql'), telemetryPaste('rollback'));
      writeFileSync(join(dir, 'commit.sql'), telemetryPaste('commit'));
      const before = psql(`select enabled || '|' || off_at from public.lp_tel_settings`);
      for (const f of ['dry.sql', 'commit.sql', 'commit.sql']) {
        const r = spawnSync('psql', [dbUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-f', join(dir, f)], { encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
        expect(r.stderr).toContain('lp-tel-retention: scheduled daily 09:17 UTC');
      }
      expect(psql(`select enabled || '|' || off_at from public.lp_tel_settings`)).toBe(before);
      expect(psql(`select count(*) from cron.job where jobname = 'lp-tel-retention'`)).toBe('1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
