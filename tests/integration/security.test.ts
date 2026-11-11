// Security matrix (spec §6 "Every route", §9.6): every route requires a session (except POST /api/session),
// every mutation requires same-origin, every JSON response is no-store, no CORS is granted, unknown API
// paths are JSON 404s, RLS is on with no policies, anon can neither read the tables nor run the functions.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { STATUS } from '@/lib/domain';
import { ROOT } from '../../scripts/test-env.mjs';
import { EVENT_ID, ORIGIN, api, cookieFor, createBody, createRequest, newStaff, psql, randomUUID, withTestServer } from './harness';

withTestServer();

const SEED_ID = '5eed0000-0000-4000-8000-000000001012';
const SEED_PHOTO = 'f0f0f0f0-0000-4000-8000-000000010121';

type Route = { method: string; path: string; body?: () => unknown; mutation: boolean };

function photoForm(): FormData {
  const f = new FormData();
  f.set('photoId', randomUUID());
  f.set('timing', 'today');
  // A real (decodable) JPEG, in case a refusal ever regressed into storing it.
  f.set('photo', new Blob([new Uint8Array(readFileSync(join(ROOT, 'supabase', 'seed-photos', 'photo_thumb.jpg')))], { type: 'image/jpeg' }), 'p.jpg');
  return f;
}

const ROUTES: Route[] = [
  { method: 'GET', path: '/api/session', mutation: false },
  { method: 'DELETE', path: '/api/session', mutation: true },
  { method: 'GET', path: '/api/sync', mutation: false },
  { method: 'GET', path: `/api/sync?ids=${SEED_ID}`, mutation: false },
  { method: 'POST', path: '/api/requests', body: () => createBody(), mutation: true },
  { method: 'GET', path: `/api/requests/${SEED_ID}`, mutation: false },
  { method: 'PATCH', path: `/api/requests/${SEED_ID}`, body: () => ({ patch: { hair: 'x' }, expectedVersion: 0 }), mutation: true },
  { method: 'POST', path: `/api/requests/${SEED_ID}/status`, body: () => ({ status: STATUS.inMedical, expectedVersion: 0, kind: 'answer' }), mutation: true },
  { method: 'POST', path: `/api/requests/${SEED_ID}/cancel`, body: () => ({ expectedVersion: 0 }), mutation: true },
  { method: 'POST', path: `/api/requests/${SEED_ID}/photos`, body: photoForm, mutation: true },
  { method: 'GET', path: `/api/photos/${SEED_PHOTO}?size=thumb`, mutation: false },
  { method: 'GET', path: '/api/stats', mutation: false },
];

function send(route: Route, opts: { cookie?: string | null; origin?: string | null } = {}) {
  const body = route.body?.();
  return api(route.path, {
    method: route.method,
    ...(body instanceof FormData ? { body } : body !== undefined ? { json: body } : {}),
    cookie: opts.cookie ?? null,
    origin: opts.origin === undefined ? (route.mutation ? ORIGIN : null) : opts.origin,
  });
}

describe('every route', () => {
  it.each(ROUTES.map((r) => [`${r.method} ${r.path.split('?')[0]}`, r] as const))('%s: 401 without a session (JSON, no-store)', async (_n, route) => {
    const res = await send(route);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.body).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
  });

  it.each(ROUTES.map((r) => [`${r.method} ${r.path.split('?')[0]}`, r] as const))('%s: 401 with a forged cookie', async (_n, route) => {
    const forged = (await cookieFor(newStaff())).replace(/\.[^.]+$/, '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect((await send(route, { cookie: forged })).status).toBe(401);
  });

  it.each(ROUTES.filter((r) => r.mutation).map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s: 403 bad_origin with a valid session but a foreign / missing Origin, and nothing changes',
    async (_n, route) => {
      const cookie = await cookieFor(newStaff());
      const before = psql(`select row_version from public.patients where id = '${SEED_ID}'`);
      for (const origin of ['https://evil.example', null, 'null', ORIGIN.replace('127.0.0.1', 'localhost')]) {
        const res = await send(route, { cookie, origin });
        expect(res.status, String(origin)).toBe(403);
        expect(res.body.error.code).toBe('bad_origin');
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
      expect(psql(`select row_version from public.patients where id = '${SEED_ID}'`)).toBe(before);
    },
  );

  it.each(ROUTES.filter((r) => !r.mutation).map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s: a read works with a session and grants no CORS',
    async (_n, route) => {
      const res = await send(route, { cookie: await cookieFor(newStaff()), origin: 'https://evil.example' });
      expect([200, 302]).toContain(res.status);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      if (res.status === 200) expect(res.headers.get('cache-control')).toBe('no-store');
    },
  );

  it('a preflight from another origin is not granted', async () => {
    const res = await api('/api/requests', {
      method: 'OPTIONS',
      origin: 'https://evil.example',
      headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('identity is never taken from the body: created_by is the session staff', async () => {
    const staff = newStaff();
    const r = await createRequest(staff);
    expect(r.createdBy).toBe(`${staff.staffName} · ${staff.team}`);
  });
});

describe('unknown API paths', () => {
  // /api/export (the CSV) was removed in v2.5 (A50): it falls through to the unknown-route handler.
  it.each(['/api/login', '/api/logout', '/api/patients', `/api/patients/${SEED_ID}`, '/api/nope/deeper', '/api/export'])('%s → JSON 404', async (path) => {
    for (const method of ['GET', 'POST']) {
      const res = await api(path, { method, cookie: await cookieFor(newStaff()) });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'not_found', message: 'Not found' } });
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('GET /api/export is gone (A50): a JSON 404 with or without a session, never a CSV attachment', async () => {
    for (const cookie of [null, await cookieFor(newStaff())]) {
      const res = await api('/api/export', { cookie });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('content-disposition')).toBeNull();
      expect(res.body).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    }
  });
});

describe('database exposure', () => {
  it('RLS is on for every app table, with no policies', () => {
    const rows = psql(`
      select c.relname || ':' || c.relrowsecurity || ':' || (select count(*) from pg_policies p where p.tablename = c.relname)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('patients', 'audit_events', 'patient_photos', 'lp_login_attempts')
      order by c.relname`).split('\n');
    expect(rows).toEqual(['audit_events:true:0', 'lp_login_attempts:true:0', 'patient_photos:true:0', 'patients:true:0']);
  });

  it('anon (publishable key) can neither read the tables nor execute any lp_* function', async () => {
    const key = process.env.SUPABASE_PUBLISHABLE_KEY;
    expect(key).toBeTruthy();
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL as string, key as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (const table of ['patients', 'audit_events', 'patient_photos', 'lp_login_attempts']) {
      const { data, error } = await anon.from(table).select('*').limit(1);
      expect(error !== null || (Array.isArray(data) && data.length === 0), table).toBe(true);
    }
    const calls: Array<[string, Record<string, unknown>]> = [
      ['lp_stats', { p_event: EVENT_ID }],
      ['lp_sync', { p_event: EVENT_ID, p_since: null, p_ids: null, p_reconcile: false, p_after_at: null, p_after_id: null, p_limit: 1 }],
      ['lp_detail', { p_event: EVENT_ID, p_id: SEED_ID }],
      ['lp_create_request', { p_event: EVENT_ID, p: createBody(), p_staff: 'X · Medical' }],
      ['lp_event_create', { p: { slug: 'nope' } }],
      ['lp_auth_secrets', {}],
      ['lp_set_status', { p_event: EVENT_ID, p_id: SEED_ID, p_expected_version: 0, p_status: STATUS.inMedical, p_staff: 'X · Medical', p_kind: 'answer' }],
      ['lp_login_begin', { p_ip: '198.18.0.1', p_name_key: 'x' }],
    ];
    for (const [fn, args] of calls) {
      const { error } = await anon.rpc(fn, args);
      expect(error?.code, fn).toBe('42501');
    }
  });

  it('only service_role may execute the lp_* functions (catalog check)', () => {
    const bad = psql(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'lp\\_%' and p.proname <> 'lp_touch'
        and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`);
    expect(bad).toBe('');
  });
});
