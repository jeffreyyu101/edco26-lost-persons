// Team join link, server side (J1; Events): signInSchema takes exactly one of password / invite; a link carries
// "<slug>.<code>" and only the code's SHA-256 is stored on its event, compared in constant time and accepted before
// the event's join-link expiry (an archived event's link still matches, for the Ended screen); the sign-in log line
// names only the method. Synthetic values only.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inviteSignInBody, signInBody } from '@/components/signin/logic';
import { joinToken, newJoinCode, parseJoinToken, pickInvite, sha256Hex, type InviteCandidate } from '@/lib/server/events';
import { logSignIn } from '@/lib/server/log';
import { signInSchema } from '@/lib/validation';

const CODE = 'unit-test-join-code-0123456789abcdefghijklmnop';
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const EXPIRES = '2026-11-09T12:00:00Z';
const EXPIRES_MS = Date.parse(EXPIRES);

describe('signInSchema: exactly one of password or invite', () => {
  const who = { staffName: '  Dana   Kim ', team: 'Medical' };

  it('password only: unchanged output {staffName, team, password}', () => {
    expect(signInSchema.parse({ ...who, password: 'pw' })).toEqual({ staffName: 'Dana Kim', team: 'Medical', password: 'pw' });
  });

  it('invite only: {staffName, team, invite}, with the canonical team', () => {
    expect(signInSchema.parse({ ...who, invite: CODE })).toEqual({ staffName: 'Dana Kim', team: 'Medical', invite: CODE });
    expect(signInSchema.parse({ staffName: 'Sam Lee', team: 'Other', otherTeam: ' dispatch ', invite: CODE })).toEqual({
      staffName: 'Sam Lee',
      team: 'GC/HX - Dispatch',
      invite: CODE,
    });
  });

  it('both → refused on invite; neither → refused on password', () => {
    const both = signInSchema.safeParse({ ...who, password: 'pw', invite: CODE });
    expect(both.success).toBe(false);
    expect(both.error?.issues.map((i) => i.path.join('.'))).toEqual(['invite']);
    const neither = signInSchema.safeParse(who);
    expect(neither.success).toBe(false);
    expect(neither.error?.issues.map((i) => i.path.join('.'))).toEqual(['password']);
  });

  it('invite is 1–200 characters and a string', () => {
    expect(signInSchema.safeParse({ ...who, invite: '' }).success).toBe(false);
    expect(signInSchema.safeParse({ ...who, invite: 'x'.repeat(201) }).success).toBe(false);
    expect(signInSchema.safeParse({ ...who, invite: 'x'.repeat(200) }).success).toBe(true);
    expect(signInSchema.safeParse({ ...who, invite: 42 }).success).toBe(false);
    expect(signInSchema.safeParse({ ...who, invite: null }).success).toBe(false);
  });

  it('the client bodies parse: password and link, card and Other team', () => {
    for (const identity of [{ name: 'Dana Kim', team: 'Medical' }, { name: 'Sam Lee', team: 'Info Booth' }]) {
      expect(signInSchema.safeParse(signInBody(identity, 'pw')).success).toBe(true);
      const parsed = signInSchema.parse(inviteSignInBody(identity, CODE));
      expect(parsed).toEqual({ staffName: identity.name, team: identity.team, invite: CODE });
      expect('password' in parsed).toBe(false);
    }
  });
});

describe('(events) join tokens "<slug>.<code>" and their match', () => {
  const ID = '10ca1000-0000-4000-8000-000000000001';
  const OTHER = '10ca1000-0000-4000-8000-000000000002';
  const live = (code = CODE, expiresAt: string | null = EXPIRES, id = ID): InviteCandidate => ({ id, stage: 'live', sha256: sha256(code), expiresAt });
  const before = EXPIRES_MS - 1;

  it('parses the slug off the front; a token without a slug-like prefix is all code (an older link)', () => {
    expect(parseJoinToken(`warped-orl.${CODE}`)).toEqual({ slug: 'warped-orl', code: CODE });
    expect(parseJoinToken(` Local.${CODE} `)).toEqual({ slug: 'local', code: CODE });
    expect(parseJoinToken(CODE)).toEqual({ slug: null, code: CODE });
    expect(parseJoinToken('.abc')).toEqual({ slug: null, code: '.abc' });
    expect(parseJoinToken('x.abc')).toEqual({ slug: null, code: 'x.abc' });
    expect(joinToken('local', CODE)).toBe(`local.${CODE}`);
  });

  it('the right code before the expiry matches its event', () => {
    expect(pickInvite([live()], CODE, before)).toEqual({ eventId: ID, stage: 'live' });
    expect(pickInvite([live('another-code-0123456789', EXPIRES, OTHER), live()], CODE, before)).toEqual({ eventId: ID, stage: 'live' });
  });

  it('a wrong code, a near miss, other lengths and an empty one are refused', () => {
    for (const wrong of ['nope', `${CODE} `, CODE.slice(0, -1), CODE.toUpperCase(), '', 'x'.repeat(5_000), sha256(CODE)]) {
      expect(pickInvite([live()], wrong, before), wrong.slice(0, 20)).toBeNull();
    }
  });

  it('from the expiry on, a live event refuses even the right code; an archived event still matches (the Ended screen)', () => {
    expect(pickInvite([live()], CODE, EXPIRES_MS)).toBeNull();
    expect(pickInvite([live(CODE, null)], CODE, before)).toBeNull();
    expect(pickInvite([{ ...live(), stage: 'archived' }], CODE, EXPIRES_MS + 60_000)).toEqual({ eventId: ID, stage: 'archived' });
  });

  it('no candidates or a malformed stored hash: every code is refused', () => {
    expect(pickInvite([], CODE, before)).toBeNull();
    expect(pickInvite(null, CODE, before)).toBeNull();
    expect(pickInvite([{ ...live(), sha256: 'abc' }], CODE, before)).toBeNull();
  });

  it('a fresh code is 32 random bytes as base64url, and only its SHA-256 is ever stored', () => {
    const code = newJoinCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(code, 'base64url')).toHaveLength(32);
    expect(sha256Hex(code)).toBe(sha256(code));
    expect(newJoinCode()).not.toBe(code);
  });
});

describe('logSignIn', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prints the method and the outcome only', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logSignIn('invite', true);
    logSignIn('password', false);
    expect(info.mock.calls.map((c) => JSON.parse(String(c[0])))).toEqual([
      { lp: 'signin', method: 'invite', ok: true },
      { lp: 'signin', method: 'password', ok: false },
    ]);
    // A method that isn't one of the two can't put anything else in the line.
    logSignIn(CODE as 'invite', 'yes' as unknown as boolean);
    expect(JSON.parse(String(info.mock.calls[2]?.[0]))).toEqual({ lp: 'signin', method: 'password', ok: false });
  });
});
