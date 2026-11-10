// Team join link (J1): POST /api/session {staffName, team, invite}.
//   * Over HTTP against the test server, which runs with the synthetic test link on (scripts/test-env.mjs
//     TEST_INVITE_ENV): the right code → 200 + the same session cookie as a password; a wrong one → 401
//     and a failed attempt that counts toward the same per-name limit as passwords; password and invite
//     together or neither → 422 (not counted); the password path is unchanged; the log names the method only.
//   * In process (the route handler itself, on the same local database): (Events) the link lives on the event
//     (only its code's SHA-256 and expiry), so an expired or switched-off link is the event's columns → 401, counted;
//     the password still signs in with the link off; "<slug>.<code>" opens only that slug's event.
// Every test uses its own fake IP and deletes its own attempts. Synthetic values only.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/session/route';
import { verifySessionToken } from '@/lib/server/session-token';
import { TEST_EVENT_SLUG, TEST_INVITE_CODE, TEST_INVITE_ENV, ensureTestEvent } from '../../scripts/test-env.mjs';
import { BASE, EVENT_ID, ORIGIN, PASSWORD, admin, api, clearAttempts, freshIp, pii, psql, serverLogPath, setCookies, uniq, withTestServer } from './harness';

withTestServer();

// Neither the code nor its hash may ever reach the server log (checked when the file ends).
const CODE = pii(TEST_INVITE_CODE);
pii(TEST_INVITE_ENV.INVITE_CODE_SHA256);

const ips: string[] = [];
afterEach(async () => {
  while (ips.length) await clearAttempts(ips.pop() as string);
});
async function ip(): Promise<string> {
  const v = await freshIp();
  ips.push(v);
  return v;
}

async function attemptsFor(ipValue: string) {
  const { data, error } = await admin().from('lp_login_attempts').select('name_key, ok').eq('ip', ipValue);
  if (error) throw new Error(error.code);
  return data as Array<{ name_key: string; ok: boolean | null }>;
}

const name = () => pii(`TEST-S Join ${uniq()}`);

describe('POST /api/session with the team link (test server, link on)', () => {
  it('the right code → 200 SessionInfo and the same HttpOnly cookie as a password; recorded as ok', async () => {
    const addr = await ip();
    const staffName = name();
    const res = await api('/api/session', { json: { staffName, team: 'Medical', invite: CODE }, headers: { 'x-real-ip': addr } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toMatchObject({ staffName, team: 'Medical', staff: `${staffName} · Medical` });
    const cookies = setCookies(res.headers);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^lp_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Expires=/);
    const claims = await verifySessionToken(/^lp_session=([^;]*)/.exec(cookies[0] as string)?.[1], process.env.SESSION_SECRET?.trim());
    expect(claims).toMatchObject({ staffName, team: 'Medical' });
    expect(res.body.expiresAt).toBe(new Date((claims?.exp ?? 0) * 1000).toISOString());
    // The cookie opens the app's API.
    const me = await api('/api/session', { cookie: cookies[0]?.split(';')[0] ?? '' });
    expect(me.status).toBe(200);
    expect(await attemptsFor(addr)).toEqual([{ name_key: staffName.toLowerCase(), ok: true }]);
  });

  it('Other team with the link stores the canonical team', async () => {
    const res = await api('/api/session', {
      json: { staffName: name(), team: 'Other', otherTeam: ' dispatch ', invite: CODE },
      headers: { 'x-real-ip': await ip() },
    });
    expect(res.status).toBe(200);
    expect(res.body.team).toBe('GC/HX - Dispatch');
  });

  it('a wrong code → 401 on field invite, no cookie, a failed attempt', async () => {
    const addr = await ip();
    const res = await api('/api/session', { json: { staffName: name(), team: 'Medical', invite: `${CODE}x` }, headers: { 'x-real-ip': addr } });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'unauthorized', field: 'invite' });
    expect(setCookies(res.headers)).toHaveLength(0);
    expect((await attemptsFor(addr)).map((r) => r.ok)).toEqual([false]);
  });

  it('wrong codes count toward the same limit as wrong passwords: 5 + 5 → even the right code is 429', async () => {
    const addr = await ip();
    const staffName = name();
    for (let i = 0; i < 5; i += 1) {
      expect((await api('/api/session', { json: { staffName, team: 'Medical', password: `wrong-${i}` }, headers: { 'x-real-ip': addr } })).status).toBe(401);
      expect((await api('/api/session', { json: { staffName, team: 'Medical', invite: `wrong-${i}` }, headers: { 'x-real-ip': addr } })).status).toBe(401);
    }
    const limited = await api('/api/session', { json: { staffName, team: 'Medical', invite: CODE }, headers: { 'x-real-ip': addr } });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(setCookies(limited.headers)).toHaveLength(0);
    // And the password is limited by them too.
    expect((await api('/api/session', { json: { staffName, team: 'Medical', password: PASSWORD }, headers: { 'x-real-ip': addr } })).status).toBe(429);
    expect((await attemptsFor(addr)).filter((r) => r.ok === false)).toHaveLength(10);
  });

  it.each([
    ['both password and invite', { password: PASSWORD, invite: CODE }, 'invite'],
    ['neither', {}, 'password'],
    ['an empty invite', { invite: '' }, 'invite'],
  ])('%s → 422, not counted as an attempt', async (_label, credential, field) => {
    const addr = await ip();
    const res = await api('/api/session', { json: { staffName: name(), team: 'Medical', ...credential }, headers: { 'x-real-ip': addr } });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'invalid', field });
    expect(setCookies(res.headers)).toHaveLength(0);
    expect(await attemptsFor(addr)).toEqual([]);
  });

  it('the password path is unchanged: right → 200 + cookie, wrong → 401 "Incorrect password"', async () => {
    const right = await api('/api/session', { json: { staffName: name(), team: 'Medical', password: PASSWORD }, headers: { 'x-real-ip': await ip() } });
    expect(right.status).toBe(200);
    expect(setCookies(right.headers)).toHaveLength(1);
    const wrong = await api('/api/session', { json: { staffName: name(), team: 'Medical', password: CODE }, headers: { 'x-real-ip': await ip() } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toMatchObject({ code: 'unauthorized', message: 'Incorrect password', field: 'password' });
  });

  it('the server log names the method of each sign-in, never the code', async () => {
    await api('/api/session', { json: { staffName: name(), team: 'Medical', invite: CODE }, headers: { 'x-real-ip': await ip() } });
    const path = serverLogPath();
    if (!path) return; // A server started outside the harness: its log is unknown (the end-of-file check covers LP_SERVER_LOG).
    // stdout is block-buffered in a child: give it a moment to reach the file.
    await expect.poll(() => readFileSync(path, 'utf8'), { timeout: 5_000 }).toContain('{"lp":"signin","method":"invite","ok":true}');
    const log = readFileSync(path, 'utf8');
    expect(log).toContain('{"lp":"signin","method":"password","ok":true}');
    expect(log).toContain('{"lp":"signin","method":"invite","ok":false}');
    expect(log).not.toContain(CODE);
    expect(log).not.toContain(TEST_INVITE_ENV.INVITE_CODE_SHA256);
  });
});

describe('POST /api/session with the team link (route in process; the link lives on the event)', () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    for (const level of ['info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const line of lines) {
      expect(line).not.toContain(CODE);
      expect(line).not.toContain(TEST_INVITE_ENV.INVITE_CODE_SHA256);
    }
    // (Events) The test event's link back as the setups leave it (TEST_INVITE_ENV).
    await ensureTestEvent();
  });

  /** (Events) Sets the test event's join-link columns for one test. */
  function useInvite(set: string): void {
    psql(`update public.events set ${set} where id = '${EVENT_ID}'`);
  }

  async function post(body: Record<string, unknown>, addr: string) {
    const request = new Request(`${BASE}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-host': new URL(BASE).host, 'x-real-ip': addr },
      body: JSON.stringify(body),
    });
    const res = await POST(request, { params: Promise.resolve({}) });
    return { status: res.status, body: await res.json(), cookies: res.headers.getSetCookie() };
  }

  it('control: the test link signs in in process too, with or without the event slug in front', async () => {
    const res = await post({ staffName: name(), team: 'Medical', invite: CODE }, await ip());
    expect(res.status).toBe(200);
    expect(res.cookies).toHaveLength(1);
    expect(res.body).toMatchObject({ role: 'staff', eventId: EVENT_ID, event: { slug: TEST_EVENT_SLUG } });
    expect(lines).toContain('{"lp":"signin","method":"invite","ok":true}');
    const slugged = await post({ staffName: name(), team: 'Medical', invite: `${TEST_EVENT_SLUG}.${CODE}` }, await ip());
    expect(slugged.status).toBe(200);
    // Another event's slug in front never opens this event.
    const wrongSlug = await post({ staffName: name(), team: 'Medical', invite: `edco26.${CODE}` }, await ip());
    expect(wrongSlug.status).toBe(401);
  });

  it.each([
    ['expired', `invite_expires_at = timestamptz '2026-01-01T00:00:00Z'`],
    ['switched off', 'invite_code_sha256 = null, invite_expires_at = null'],
  ] as const)('%s: the right code → 401 field invite, no cookie, counted toward the limit', async (_label, set) => {
    useInvite(set);
    const addr = await ip();
    const staffName = name();
    for (let i = 0; i < 10; i += 1) {
      const res = await post({ staffName, team: 'Medical', invite: CODE }, addr);
      expect(res.status, `attempt ${i + 1}`).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'unauthorized', field: 'invite' });
      expect(res.cookies).toHaveLength(0);
    }
    expect((await attemptsFor(addr)).filter((r) => r.ok === false)).toHaveLength(10);
    // The 11th, even with the right password, is refused by the limit.
    expect((await post({ staffName, team: 'Medical', password: PASSWORD }, addr)).status).toBe(429);
    expect(lines.filter((l) => l === '{"lp":"signin","method":"invite","ok":false}')).toHaveLength(10);
  });

  it('with the link off, the password still signs in', async () => {
    useInvite('invite_code_sha256 = null, invite_expires_at = null');
    const res = await post({ staffName: name(), team: 'Medical', password: PASSWORD }, await ip());
    expect(res.status).toBe(200);
    expect(res.cookies).toHaveLength(1);
    expect(lines).toContain('{"lp":"signin","method":"password","ok":true}');
  });
});
