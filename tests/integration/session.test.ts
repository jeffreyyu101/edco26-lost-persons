// /api/session (spec §6, A16, A27, A28): sign in, who am I, sign out, cookie flags, sliding re-issue,
// absolute cap, validation, Origin. Login rate limits are in login-limits.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_ABSOLUTE_SECONDS, SESSION_IDLE_SECONDS, verifySessionToken } from '@/lib/server/session-token';
import {
  ORIGIN,
  PASSWORD,
  api,
  clearAttempts,
  cookieFor,
  freshIp,
  newStaff,
  pii,
  setCookies,
  uniq,
  withTestServer,
} from './harness';

withTestServer();

const ips: string[] = [];
afterEach(async () => {
  while (ips.length) await clearAttempts(ips.pop() as string);
});

async function ip(): Promise<string> {
  const v = await freshIp();
  ips.push(v);
  return v;
}

function cookieAttrs(setCookie: string): Record<string, string | true> {
  const [pair, ...attrs] = setCookie.split(';').map((s) => s.trim());
  const out: Record<string, string | true> = { _pair: pair ?? '' };
  for (const a of attrs) {
    const eq = a.indexOf('=');
    if (eq < 0) out[a.toLowerCase()] = true;
    else out[a.slice(0, eq).toLowerCase()] = a.slice(eq + 1);
  }
  return out;
}

function tokenOf(setCookie: string): string {
  return /^lp_session=([^;]*)/.exec(setCookie)?.[1] ?? '';
}

describe('POST /api/session', () => {
  it('signs in: SessionInfo body, HttpOnly SameSite=Lax cookie, no Secure over http', async () => {
    const name = pii(`TEST-S Signin ${uniq()}`);
    const res = await api('/api/session', {
      json: { staffName: `  ${name}  `, team: 'Medical', password: PASSWORD },
      headers: { 'x-real-ip': await ip() },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toMatchObject({ staffName: name, team: 'Medical', staff: `${name} · Medical` });
    const cookies = setCookies(res.headers);
    expect(cookies).toHaveLength(1);
    const attrs = cookieAttrs(cookies[0] as string);
    expect(attrs.httponly).toBe(true);
    expect(attrs.samesite).toBe('Lax');
    expect(attrs.path).toBe('/');
    expect(attrs.secure).toBeUndefined();
    expect(Number(attrs['max-age'])).toBeGreaterThan(SESSION_IDLE_SECONDS - 60);
    const claims = await verifySessionToken(tokenOf(cookies[0] as string), process.env.SESSION_SECRET?.trim());
    expect(claims).not.toBeNull();
    // A27: expiresAt is the exp of the cookie just issued.
    expect(res.body.expiresAt).toBe(new Date((claims?.exp ?? 0) * 1000).toISOString());
    expect(Math.abs(Date.parse(res.body.expiresAt) - (Date.now() + SESSION_IDLE_SECONDS * 1000))).toBeLessThan(120_000);
  });

  it('sets Secure when the request came in over https (A16)', async () => {
    const res = await api('/api/session', {
      json: { staffName: pii(`TEST-S Https ${uniq()}`), team: 'Medical', password: PASSWORD },
      headers: { 'x-real-ip': await ip(), 'x-forwarded-proto': 'https' },
      origin: ORIGIN.replace('http://', 'https://'),
    });
    expect(res.status).toBe(200);
    expect(cookieAttrs(setCookies(res.headers)[0] as string).secure).toBe(true);
  });

  it("(events) Other text naming one of the event's teams (label or short name, any case) stores that team: 'dispatch' → GC/HX - Dispatch; unknown text is kept", async () => {
    const a = await api('/api/session', {
      json: { staffName: pii(`TEST-S Other ${uniq()}`), team: 'Other', otherTeam: ' dispatch ', password: PASSWORD },
      headers: { 'x-real-ip': await ip() },
    });
    expect(a.status).toBe(200);
    expect(a.body.team).toBe('GC/HX - Dispatch');
    const b = await api('/api/session', {
      json: { staffName: pii(`TEST-S Other ${uniq()}`), team: 'Other', otherTeam: 'Info   Booth', password: PASSWORD },
      headers: { 'x-real-ip': await ip() },
    });
    expect(b.status).toBe(200);
    expect(b.body.team).toBe('Info Booth');
  });

  it('wrong password → 401 "Incorrect password" with field password, and no cookie', async () => {
    const res = await api('/api/session', {
      json: { staffName: pii(`TEST-S Wrong ${uniq()}`), team: 'Medical', password: 'not-the-password' },
      headers: { 'x-real-ip': await ip() },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'unauthorized', message: 'Incorrect password', field: 'password' });
    expect(setCookies(res.headers)).toHaveLength(0);
  });

  it.each([
    ['short name', { staffName: 'A', team: 'Medical' }, 'staffName'],
    ['name with the separator', { staffName: 'Dana · Kim', team: 'Medical' }, 'staffName'],
    // (Events) A team outside the event's is free text like Other's, so only its shape is checked here.
    ['team too short', { staffName: 'TEST-S Val', team: 'S' }, 'team'],
    ['Other without text', { staffName: 'TEST-S Val', team: 'Other' }, 'otherTeam'],
    ['extra key', { staffName: 'TEST-S Val', team: 'Medical', admin: true }, undefined],
  ])('validation: %s → 422', async (_label, body, field) => {
    const res = await api('/api/session', { json: { password: PASSWORD, ...body }, headers: { 'x-real-ip': await ip() } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid');
    if (field) expect(res.body.error.field).toBe(field);
  });

  it('malformed JSON → 400, body over 64 KB → 413', async () => {
    const bad = await api('/api/session', { body: '{"staffName":', headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('bad_request');
    const big = await api('/api/session', {
      json: { staffName: 'TEST-S Big', team: 'Medical', password: 'x'.repeat(70_000) },
    });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('too_large');
  });

  it('requires same-origin: missing, foreign and "null" Origin → 403 bad_origin', async () => {
    const body = { staffName: 'TEST-S Origin', team: 'Medical', password: PASSWORD };
    for (const origin of [null, 'https://evil.example', 'null', 'http://127.0.0.1:1']) {
      const res = await api('/api/session', { json: body, origin });
      expect(res.status, String(origin)).toBe(403);
      expect(res.body.error.code).toBe('bad_origin');
      expect(setCookies(res.headers)).toHaveLength(0);
    }
  });
});

describe('GET /api/session', () => {
  it('returns SessionInfo for a valid cookie and 401 without one', async () => {
    const staff = newStaff('GC/HX - Base');
    const res = await api('/api/session', { cookie: await cookieFor(staff) });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toMatchObject({ staffName: staff.staffName, team: 'GC/HX - Base', staff: `${staff.staffName} · GC/HX - Base` });
    expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now());
    // A fresh token (< 1 h) is not re-issued.
    expect(setCookies(res.headers)).toHaveLength(0);

    const none = await api('/api/session');
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('unauthorized');
  });

  it('rejects a tampered, foreign-signed or expired token', async () => {
    const good = await cookieFor(newStaff());
    const tampered = `${good.slice(0, -3)}${good.endsWith('A') ? 'B' : 'A'}xx`;
    expect((await api('/api/session', { cookie: tampered })).status).toBe(401);
    expect((await api('/api/session', { cookie: 'lp_session=not.a.jwt' })).status).toBe(401);
    const expired = await cookieFor(newStaff(), { issuedAgo: SESSION_IDLE_SECONDS + 5 });
    expect((await api('/api/session', { cookie: expired })).status).toBe(401);
  });

  it('re-issues the cookie once the token is over 1 h old (sliding 12 h, same sid)', async () => {
    const staff = newStaff();
    const old = await cookieFor(staff, { issuedAgo: 2 * 3600 });
    const oldClaims = await verifySessionToken(old.slice('lp_session='.length), process.env.SESSION_SECRET?.trim());
    const res = await api('/api/session', { cookie: old });
    expect(res.status).toBe(200);
    const cookies = setCookies(res.headers);
    expect(cookies).toHaveLength(1);
    const attrs = cookieAttrs(cookies[0] as string);
    expect(attrs.httponly).toBe(true);
    expect(attrs.samesite).toBe('Lax');
    const claims = await verifySessionToken(tokenOf(cookies[0] as string), process.env.SESSION_SECRET?.trim());
    expect(claims?.sid).toBe(oldClaims?.sid);
    expect(claims?.exp).toBeGreaterThan(oldClaims?.exp ?? 0);
    // GET returns the expiry of the cookie it just issued.
    expect(res.body.expiresAt).toBe(new Date((claims?.exp ?? 0) * 1000).toISOString());
  });

  it('re-issues on other authenticated routes too (sync)', async () => {
    const res = await api('/api/sync?ids=5eed0000-0000-4000-8000-000000001012', {
      cookie: await cookieFor(newStaff(), { issuedAgo: 3 * 3600 }),
    });
    expect(res.status).toBe(200);
    expect(setCookies(res.headers)).toHaveLength(1);
  });

  it('never extends past the 36 h absolute cap', async () => {
    // First sign-in 35.5 h ago, token issued 2 h ago: it already expires at the cap, so no re-issue.
    const capped = await cookieFor(newStaff(), { issuedAgo: 2 * 3600, firstIssuedAgo: 35.5 * 3600 });
    const res = await api('/api/session', { cookie: capped });
    expect(res.status).toBe(200);
    expect(setCookies(res.headers)).toHaveLength(0);
    const capAt = Date.now() + 0.5 * 3600 * 1000;
    expect(Math.abs(Date.parse(res.body.expiresAt) - capAt)).toBeLessThan(120_000);

    // First sign-in 25 h ago, token issued 2 h ago (expires in 10 h): the re-issued cookie stops at
    // first + 36 h (11 h from now), not 12 h from now.
    const nearCap = await cookieFor(newStaff(), { issuedAgo: 2 * 3600, firstIssuedAgo: 25 * 3600 });
    const res2 = await api('/api/session', { cookie: nearCap });
    const claims = await verifySessionToken(tokenOf(setCookies(res2.headers)[0] ?? ''), process.env.SESSION_SECRET?.trim());
    expect(claims).not.toBeNull();
    expect((claims?.exp ?? 0) - (claims?.firstIssuedAt ?? 0)).toBe(SESSION_ABSOLUTE_SECONDS);

    // Past the cap → 401.
    const past = await cookieFor(newStaff(), { issuedAgo: 2 * 3600, firstIssuedAgo: SESSION_ABSOLUTE_SECONDS + 60 }).catch(() => null);
    if (past) expect((await api('/api/session', { cookie: past })).status).toBe(401);
  });
});

describe('DELETE /api/session', () => {
  it('clears the cookie (even when the token was due a re-issue)', async () => {
    const res = await api('/api/session', { method: 'DELETE', cookie: await cookieFor(newStaff(), { issuedAgo: 2 * 3600 }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const cookies = setCookies(res.headers);
    expect(cookies).toHaveLength(1);
    const attrs = cookieAttrs(cookies[0] as string);
    expect(attrs._pair).toBe('lp_session=');
    expect(attrs['max-age']).toBe('0');
  });

  it('requires a session and same-origin', async () => {
    expect((await api('/api/session', { method: 'DELETE' })).status).toBe(401);
    const cookie = await cookieFor(newStaff());
    const foreign = await api('/api/session', { method: 'DELETE', cookie, origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('bad_origin');
    expect(setCookies(foreign.headers)).toHaveLength(0);
  });
});
