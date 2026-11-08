// lib/server/telemetry.ts: the team key (from the session, never the body), the skew clamp, envelope versus per-event
// validation (no 4-digit run in any stored string), the body reader's caps (48 KB wire, 256 KB inflated, a gzip bomb
// stops; bytes counted inflated), the config cache (off only when the settings can't exist, 503 for a transient
// failure), the session quota key, and the server rows (push_send per team).
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]>, answer: (fn: string): unknown => (fn === 'lp_tel_config' ? { on: true, enabled: true, until: Date.now() + 3_600_000, flushSeconds: 60, sample: 1 } : 1) }));
vi.mock('@/lib/server/supabase', () => ({
  rpc: async (fn: string, args: unknown) => {
    rpcMock.calls.push([fn, args]);
    const out = rpcMock.answer(fn);
    if (out instanceof Error) throw out;
    return out;
  },
}));

const { assertTelemetryOrigin, clampSkew, parseBatch, quotaKey, readTelemetryBody, recordPushSend, resetTelemetryConfigCache, teamKey, telemetryConfig } = await import('@/lib/server/telemetry');
const { ApiFailure } = await import('@/lib/server/errors');

const SENT = 1_762_600_000_000;
const ctx = { plat: 'ios', osv: 18, eng: 'webkit', sa: true, lay: 'phone', dpr: 3, touch: true, build: 'none', eff: 'na', mem: -1 };
const batch = (ev: unknown[], over: Record<string, unknown> = {}) => JSON.stringify({ v: 1, b: 'batch0000001', d: 'device0000000001', s: 'sess000001', sent: SENT, ctx, ev, ...over });
const req = (body: BodyInit, type: string) => new Request('http://lp.test/api/telemetry', { method: 'POST', body, headers: { 'content-type': type } });

beforeEach(() => {
  rpcMock.calls = [];
  resetTelemetryConfigCache();
});

describe('teamKey', () => {
  it('the four canonical teams, their aliases, and anything else as other', () => {
    expect(teamKey('Medical')).toBe('medical');
    expect(teamKey('GC/HX - Dispatch')).toBe('dispatch');
    expect(teamKey('GC/HX - Base')).toBe('base');
    expect(teamKey('GC/HX - Special Operations/Med Transpo')).toBe('transpo');
    expect(teamKey('gchx dispatch')).toBe('dispatch');
    expect(teamKey('Med Transpo')).toBe('transpo');
    expect(teamKey('Prevent')).toBe('other');
    expect(teamKey('TEST-S Custom Team Name')).toBe('other');
    expect(teamKey('')).toBe('other');
    expect(teamKey(null)).toBe('other');
  });
});

describe('assertTelemetryOrigin', () => {
  const r = (headers: Record<string, string>) => new Request('http://lp.test/api/telemetry', { method: 'POST', headers: { host: 'lp.test', ...headers } });
  it('a fetch: its Origin must be this site', () => {
    expect(() => assertTelemetryOrigin(r({ origin: 'http://lp.test' }))).not.toThrow();
    expect(() => assertTelemetryOrigin(r({ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' }))).toThrow(expect.objectContaining({ status: 403 }));
  });
  it('an iPhone beacon (Origin: null under no-referrer): only with Sec-Fetch-Site same-origin', () => {
    expect(() => assertTelemetryOrigin(r({ origin: 'null', 'sec-fetch-site': 'same-origin' }))).not.toThrow();
    expect(() => assertTelemetryOrigin(r({ 'sec-fetch-site': 'same-origin' }))).not.toThrow();
    for (const site of ['cross-site', 'same-site', 'none']) expect(() => assertTelemetryOrigin(r({ origin: 'null', 'sec-fetch-site': site }))).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => assertTelemetryOrigin(r({}))).toThrow(expect.objectContaining({ status: 403 }));
  });
});

describe('clampSkew', () => {
  it('0 under 1.5 s, clamped to ±24 h', () => {
    expect(clampSkew(1_400)).toBe(0);
    expect(clampSkew(-900)).toBe(0);
    expect(clampSkew(5_000)).toBe(5_000);
    expect(clampSkew(10 * 86_400_000)).toBe(86_400_000);
    expect(clampSkew(-10 * 86_400_000)).toBe(-86_400_000);
    expect(clampSkew(Number.NaN)).toBe(0);
  });
});

describe('parseBatch', () => {
  it('a bad envelope is 422; bad JSON is 400', () => {
    expect(() => parseBatch('{')).toThrow(expect.objectContaining({ status: 400 }));
    for (const bad of [batch([{ n: 'view', at: SENT }], { v: 2 }), batch([{ n: 'view', at: SENT }], { d: 'Has Caps' }), batch([], {}), batch([{ n: 'view', at: SENT }], { ctx: { ...ctx, plat: 'beos' } }), batch(Array.from({ length: 301 }, () => ({ n: 'view', at: SENT })))]) {
      expect(() => parseBatch(bad)).toThrow(expect.objectContaining({ status: 422 }));
    }
  });

  it('an empty batch only as a probe', () => {
    expect(parseBatch(batch([], { probe: 1 }))).toEqual(expect.objectContaining({ probe: true, ev: [] }));
  });

  it('a bad event is dropped and counted; the rest stay', () => {
    const p = parseBatch(
      batch([
        { n: 'view', at: SENT, v: 'all' },
        { n: 'view', at: SENT, a: 'Quorra Zyxwvut' },
        { n: 'tap', at: SENT, p: { kind: 'Has Spaces' } },
        { n: 'tap', at: SENT, p: { notakey: 1 } },
        { n: 'view', at: SENT, tr: [[-1, 'v>all']] },
        { n: 'rage_tap', at: SENT, tr: [[-1, 'v>all'], [-2, 't:thread/composer-send']] },
        { n: 'view', at: SENT - 2 * 86_400_000 },
        { n: 'view', at: SENT + 120_000 },
        { n: 'push_send', at: SENT },
        { n: 'net', at: SENT, a: '/api/sync:delta', k: 3, p: { m: 'get', st: '2xx', on: true, conn: 'live', d: [120, 340, 99] } },
        { n: 'view', at: SENT, team: 'medical' },
      ]),
    );
    expect(p.ev.map((e) => e.n)).toEqual(['view', 'rage_tap', 'net']);
    expect(p.rejected).toBe(8);
  });

  it('no 4 digits in a row in any string: token, enum value or crumb (the backstop behind tok()); 3-digit statuses and letter hashes pass', () => {
    const p = parseBatch(
      batch([
        { n: 'tap', at: SENT, a: '407-555-0199', c: 'quorra-zyxwvut' },
        { n: 'tap', at: SENT, a: 'thread', c: 'x4075550199' },
        { n: 'tap', at: SENT, a: 'thread', p: { what: 'x40755' } },
        { n: 'rage_tap', at: SENT, a: 'thread', tr: [[0, 't:quorra/4075550199']] },
        { n: 'error', at: SENT, a: 'chunk:pnamfaih', c: 'typeerror', p: { type: 'typeerror', kind: 'error', fp: 'pnamfaih', line: 12345 }, tr: [[-10, 'n:/api/sync:delta:5xx:12s']] },
        { n: 'net', at: SENT, a: '/api/requests/:id', k: 1, p: { m: 'post', st: '409', on: true, conn: 'live', d: [12345] } },
      ]),
    );
    expect(p.ev.map((e) => e.n)).toEqual(['error', 'net']);
    expect(p.rejected).toBe(4);
  });

  it('the body’s team is never read (it is not in the schema)', () => {
    const p = parseBatch(batch([{ n: 'view', at: SENT }], { team: 'medical' }));
    expect(JSON.stringify(p)).not.toContain('team');
  });
});

describe('readTelemetryBody', () => {
  it('JSON, text/plain (sendBeacon) and gzip; anything else 415', async () => {
    const text = batch([{ n: 'view', at: SENT }]);
    expect((await readTelemetryBody(req(text, 'application/json'))).text).toBe(text);
    expect((await readTelemetryBody(req(text, 'text/plain;charset=UTF-8'))).text).toBe(text);
    const gz = gzipSync(text);
    const out = await readTelemetryBody(req(gz, 'application/x-lp-tel+gzip'));
    // The byte caps count what gets stored: the inflated JSON, not the gzip on the wire.
    expect(out).toEqual({ bytes: Buffer.byteLength(text), text });
    await expect(readTelemetryBody(req(text, 'application/octet-stream'))).rejects.toMatchObject({ status: 415 });
  });

  it('413 over 48 KB on the wire, and for a gzip that inflates past 256 KB (a bomb stops there)', async () => {
    await expect(readTelemetryBody(req('x'.repeat(49 * 1024), 'application/json'))).rejects.toMatchObject({ status: 413 });
    const bomb = gzipSync(Buffer.alloc(2 * 1024 * 1024, 32));
    expect(bomb.byteLength).toBeLessThan(48 * 1024);
    await expect(readTelemetryBody(req(bomb, 'application/x-lp-tel+gzip'))).rejects.toMatchObject({ status: 413 });
    await expect(readTelemetryBody(req('not gzip', 'application/x-lp-tel+gzip'))).rejects.toMatchObject({ status: 400 });
  });
});

describe('the config cache', () => {
  it('one RPC per 30 s; the auto-off passes on its own', async () => {
    expect((await telemetryConfig(1_000)).on).toBe(true);
    await telemetryConfig(20_000);
    expect(rpcMock.calls.filter(([fn]) => fn === 'lp_tel_config')).toHaveLength(1);
    await telemetryConfig(40_000);
    expect(rpcMock.calls.filter(([fn]) => fn === 'lp_tel_config')).toHaveLength(2);
    resetTelemetryConfigCache();
    rpcMock.answer = () => ({ on: true, enabled: true, until: Date.now() - 1, flushSeconds: 60, sample: 1 });
    expect((await telemetryConfig()).on).toBe(false);
  });

  it('off (cached 30 s) only when the settings can’t exist: no function, no table', async () => {
    for (const dbCode of ['PGRST202', '42883', '42P01']) {
      resetTelemetryConfigCache();
      rpcMock.calls = [];
      rpcMock.answer = () => new ApiFailure('unavailable', undefined, { dbCode });
      expect((await telemetryConfig(1_000)).on).toBe(false);
      expect((await telemetryConfig(20_000)).on).toBe(false);
      expect(rpcMock.calls).toHaveLength(1);
    }
  });

  it('a transient failure (a 503, a fetch error, the timeout) is 503 unavailable, cached 5 s only, never "off"', async () => {
    for (const dbCode of ['PGRST000', 'fetch', '57014']) {
      resetTelemetryConfigCache();
      rpcMock.calls = [];
      rpcMock.answer = () => new ApiFailure('unavailable', undefined, { dbCode });
      await expect(telemetryConfig(1_000)).rejects.toMatchObject({ status: 503 });
      await expect(telemetryConfig(4_000)).rejects.toMatchObject({ status: 503 });
      expect(rpcMock.calls).toHaveLength(1);
      rpcMock.answer = (fn) => (fn === 'lp_tel_config' ? { on: true, enabled: true, until: Date.now() + 3_600_000, flushSeconds: 60, sample: 1 } : 1);
      expect((await telemetryConfig(6_500)).on).toBe(true);
      expect(rpcMock.calls).toHaveLength(2);
    }
  });
});

describe('quotaKey', () => {
  it('from the session’s sid: stable, distinct per sign-in, and never the sid itself', () => {
    const sid = '1762600000.a1b2c3d4e5f6a1b2c3d4e5f6';
    expect(quotaKey(sid)).toMatch(/^s[0-9a-f]{20}$/);
    expect(quotaKey(sid)).toBe(quotaKey(sid));
    expect(quotaKey(`${sid}0`)).not.toBe(quotaKey(sid));
    expect(quotaKey(sid)).not.toContain('a1b2c3');
  });
});

describe('push_send rows', () => {
  it('one row per team of the devices pushed to, with ok / gone / failed counts; nothing when off', async () => {
    resetTelemetryConfigCache();
    rpcMock.answer = (fn) => (fn === 'lp_tel_config' ? { on: true, enabled: true, until: Date.now() + 3_600_000, flushSeconds: 60, sample: 1 } : 2);
    await recordPushSend(
      'new_request',
      [
        { endpoint: 'e1', staff: 'test-s ana · medical' },
        { endpoint: 'e2', staff: 'test-s rae · medical' },
        { endpoint: 'e3', staff: 'test-s dana · gc/hx - dispatch' },
      ],
      [
        { endpoint: 'e1', result: 'ok' },
        { endpoint: 'e2', result: 'gone' },
        { endpoint: 'e3', result: 'failed' },
      ],
      123.4,
    );
    const call = rpcMock.calls.find(([fn]) => fn === 'lp_tel_server_events');
    expect(call?.[1]).toEqual({
      p_rows: [
        { n: 'push_send', team: 'medical', ms: 123, k: 2, p: { kind: 'new_request', ok: 1, gone: 1, failed: 0 } },
        { n: 'push_send', team: 'dispatch', ms: 123, k: 1, p: { kind: 'new_request', ok: 0, gone: 0, failed: 1 } },
      ],
    });
    expect(JSON.stringify(call)).not.toMatch(/ana|rae|dana|e1/);
    rpcMock.calls = [];
    resetTelemetryConfigCache();
    rpcMock.answer = (fn) => (fn === 'lp_tel_config' ? { on: false } : 0);
    await recordPushSend('message', [{ endpoint: 'e1', staff: 'x · medical' }], [{ endpoint: 'e1', result: 'ok' }], 1);
    expect(rpcMock.calls.map(([fn]) => fn)).toEqual(['lp_tel_config']);
  });
});
