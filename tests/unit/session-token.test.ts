import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  SESSION_ABSOLUTE_SECONDS,
  SESSION_IDLE_SECONDS,
  claimsStaff,
  needsRefresh,
  newSid,
  sidIssuedAt,
  signSessionToken,
  verifySessionToken,
} from '@/lib/server/session-token';

const SECRET = 'unit-test-session-secret-0123456789abcdef';
const T0 = 1_793_000_000; // fixed epoch seconds
const EVENT = '10ca1000-0000-4000-8000-000000000001';

describe('session token', () => {
  it('round-trips claims and carries the first sign-in time in sid', async () => {
    const signed = await signSessionToken({ staffName: 'Dana Kim', team: 'GC/HX - Dispatch', eventId: '10ca1000-0000-4000-8000-000000000001', role: 'staff' }, SECRET, T0);
    expect(signed).not.toBeNull();
    const claims = await verifySessionToken(signed!.token, SECRET, T0 + 10);
    expect(claims).toMatchObject({ staffName: 'Dana Kim', team: 'GC/HX - Dispatch', iat: T0, exp: T0 + SESSION_IDLE_SECONDS, firstIssuedAt: T0 });
    expect(sidIssuedAt(claims!.sid)).toBe(T0);
    expect(claimsStaff(claims!)).toBe('Dana Kim · GC/HX - Dispatch');
  });

  it('expires 12 h after the last issue', async () => {
    const signed = await signSessionToken({ staffName: 'Dana Kim', team: 'Medical', eventId: '10ca1000-0000-4000-8000-000000000001', role: 'staff' }, SECRET, T0);
    expect(await verifySessionToken(signed!.token, SECRET, T0 + SESSION_IDLE_SECONDS - 1)).not.toBeNull();
    expect(await verifySessionToken(signed!.token, SECRET, T0 + SESSION_IDLE_SECONDS)).toBeNull();
  });

  it('asks for a refresh after 1 h and refreshing keeps the 36 h absolute cap', async () => {
    const first = await signSessionToken({ staffName: 'Dana Kim', team: 'Medical', eventId: '10ca1000-0000-4000-8000-000000000001', role: 'staff' }, SECRET, T0);
    const claims = (await verifySessionToken(first!.token, SECRET, T0 + 3_600))!;
    expect(needsRefresh(claims, T0 + 3_599)).toBe(false);
    expect(needsRefresh(claims, T0 + 3_600)).toBe(true);

    // Refresh every 11 h: the token never lives past first sign-in + 36 h.
    let token = first!.token;
    let sid = claims.sid;
    let now = T0;
    for (let i = 0; i < 4; i += 1) {
      now += 11 * 3_600;
      const c = await verifySessionToken(token, SECRET, now);
      if (!c) break;
      const refreshed = await signSessionToken({ staffName: c.staffName, team: c.team, eventId: c.eventId, role: c.role, sid }, SECRET, now);
      if (!refreshed) break;
      expect(refreshed.claims.exp).toBeLessThanOrEqual(T0 + SESSION_ABSOLUTE_SECONDS);
      token = refreshed.token;
      sid = refreshed.claims.sid;
    }
    expect(await verifySessionToken(token, SECRET, T0 + SESSION_ABSOLUTE_SECONDS)).toBeNull();
    expect(await signSessionToken({ staffName: 'x', team: 'y', eventId: '10ca1000-0000-4000-8000-000000000001', role: 'staff', sid }, SECRET, T0 + SESSION_ABSOLUTE_SECONDS)).toBeNull();
  });

  it('rejects a wrong secret, a short secret, garbage and alg tricks', async () => {
    const signed = await signSessionToken({ staffName: 'Dana Kim', team: 'Medical', eventId: '10ca1000-0000-4000-8000-000000000001', role: 'staff' }, SECRET, T0);
    expect(await verifySessionToken(signed!.token, 'another-secret-another-secret-123456', T0)).toBeNull();
    expect(await verifySessionToken(signed!.token, 'short', T0)).toBeNull();
    expect(await verifySessionToken('not.a.jwt', SECRET, T0)).toBeNull();
    expect(await verifySessionToken(undefined, SECRET, T0)).toBeNull();
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ staffName: 'x', team: 'y', sid: newSid(T0), iat: T0, exp: T0 + 60 })).toString('base64url')}.`;
    expect(await verifySessionToken(unsigned, SECRET, T0)).toBeNull();
  });

  it('rejects tokens with a malformed sid or a lifetime over 12 h', async () => {
    const key = new TextEncoder().encode(SECRET);
    const badSid = await new SignJWT({ staffName: 'x', team: 'y', sid: 'nope', eventId: EVENT, role: 'staff' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt(T0).setExpirationTime(T0 + 60).sign(key);
    expect(await verifySessionToken(badSid, SECRET, T0)).toBeNull();
    const tooLong = await new SignJWT({ staffName: 'x', team: 'y', sid: newSid(T0), eventId: EVENT, role: 'staff' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt(T0).setExpirationTime(T0 + SESSION_IDLE_SECONDS + 60).sign(key);
    expect(await verifySessionToken(tooLong, SECRET, T0)).toBeNull();
    const noName = await new SignJWT({ staffName: '', team: 'y', sid: newSid(T0), eventId: EVENT, role: 'staff' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt(T0).setExpirationTime(T0 + 60).sign(key);
    expect(await verifySessionToken(noName, SECRET, T0)).toBeNull();
  });

  it('(events) carries eventId and role; a staff token always has an event, a lead token may have none', async () => {
    const staff = await signSessionToken({ staffName: 'Dana Kim', team: 'Medical', eventId: EVENT, role: 'staff' }, SECRET, T0);
    expect(await verifySessionToken(staff!.token, SECRET, T0 + 1)).toMatchObject({ eventId: EVENT, role: 'staff' });
    const lead = await signSessionToken({ staffName: 'Brian', team: 'Medical', eventId: null, role: 'lead' }, SECRET, T0);
    expect(await verifySessionToken(lead!.token, SECRET, T0 + 1)).toMatchObject({ eventId: null, role: 'lead' });
    expect(await signSessionToken({ staffName: 'Dana Kim', team: 'Medical', eventId: null, role: 'staff' }, SECRET, T0)).toBeNull();
    expect(await signSessionToken({ staffName: 'Dana Kim', team: 'Medical', eventId: 'not-a-uuid', role: 'staff' }, SECRET, T0)).toBeNull();
  });

  it('(events) refuses a token from before events (no role), a staff token without an event and an unknown role', async () => {
    const key = new TextEncoder().encode(SECRET);
    const mint = (claims: Record<string, unknown>) =>
      new SignJWT({ staffName: 'x', team: 'y', sid: newSid(T0), ...claims }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt(T0).setExpirationTime(T0 + 60).sign(key);
    expect(await verifySessionToken(await mint({}), SECRET, T0)).toBeNull();
    expect(await verifySessionToken(await mint({ role: 'staff', eventId: null }), SECRET, T0)).toBeNull();
    expect(await verifySessionToken(await mint({ role: 'admin', eventId: EVENT }), SECRET, T0)).toBeNull();
    expect(await verifySessionToken(await mint({ role: 'staff', eventId: 42 }), SECRET, T0)).toBeNull();
    expect(await verifySessionToken(await mint({ role: 'lead', eventId: null }), SECRET, T0)).toMatchObject({ role: 'lead', eventId: null });
  });
});
