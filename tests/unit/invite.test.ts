// Team join link, server side (J1): signInSchema takes exactly one of password / invite; the code is
// checked as a SHA-256 against INVITE_CODE_SHA256, before INVITE_EXPIRES_AT, and the link is off when they
// are unset or unreadable (never failing the server); the sign-in log line names only the method; and
// scripts/make-invite.mjs prints a fresh code and its hash without writing a file. Synthetic values only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inviteSignInBody, signInBody } from '@/components/signin/logic';
import { readInviteEnv, resetServerEnvCache, serverEnv, type InviteConfig } from '@/lib/server/env';
import { inviteMatches, verifyInvite } from '@/lib/server/invite';
import { logSignIn } from '@/lib/server/log';
import { signInSchema } from '@/lib/validation';
import { ROOT } from '../../scripts/test-env.mjs';

const CODE = 'unit-test-join-code-0123456789abcdefghijklmnop';
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const EXPIRES = '2026-11-09T12:00:00Z';
const EXPIRES_MS = Date.parse(EXPIRES);
const config = (code = CODE, expiresAt = EXPIRES_MS): InviteConfig => ({ sha256: Buffer.from(sha256(code), 'hex'), expiresAt });

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

describe('inviteMatches (hash compare and expiry)', () => {
  const before = EXPIRES_MS - 1;

  it('the right code before the expiry', () => {
    expect(inviteMatches(CODE, config(), before)).toBe(true);
  });

  it('a wrong code, a near miss, other lengths and an empty one are refused', () => {
    for (const wrong of ['nope', `${CODE} `, CODE.slice(0, -1), CODE.toUpperCase(), '', 'x'.repeat(5_000), sha256(CODE)]) {
      expect(inviteMatches(wrong, config(), before), wrong.slice(0, 20)).toBe(false);
    }
  });

  it('from the expiry on, even the right code is refused', () => {
    expect(inviteMatches(CODE, config(), EXPIRES_MS)).toBe(false);
    expect(inviteMatches(CODE, config(), EXPIRES_MS + 60_000)).toBe(false);
  });

  it('off (no config): every code is refused', () => {
    expect(inviteMatches(CODE, null, before)).toBe(false);
    expect(inviteMatches('', null, before)).toBe(false);
  });
});

describe('readInviteEnv and serverEnv().invite', () => {
  const KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_SECRET', 'APP_SHARED_PASSWORD', 'APP_SHARED_PASSWORD_HASH_B64', 'INVITE_CODE_SHA256', 'INVITE_EXPIRES_AT'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    resetServerEnvCache();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54421';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
    process.env.SESSION_SECRET = 'x'.repeat(32);
    process.env.APP_SHARED_PASSWORD = 'pw';
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetServerEnvCache();
    vi.restoreAllMocks();
  });

  it('unset: off, no problem, and the server still starts (production before the variables exist)', () => {
    expect(readInviteEnv()).toEqual({ invite: null, problem: null });
    expect(serverEnv().invite).toBeNull();
    expect(verifyInvite(CODE)).toBe(false);
  });

  it('both set: on until the expiry; upper-case hex is accepted', () => {
    process.env.INVITE_CODE_SHA256 = sha256(CODE).toUpperCase();
    process.env.INVITE_EXPIRES_AT = EXPIRES;
    const { invite, problem } = readInviteEnv();
    expect(problem).toBeNull();
    expect(invite?.expiresAt).toBe(EXPIRES_MS);
    expect(invite?.sha256.toString('hex')).toBe(sha256(CODE));
    expect(verifyInvite(CODE, EXPIRES_MS - 1)).toBe(true);
    expect(verifyInvite(CODE, EXPIRES_MS)).toBe(false);
    expect(verifyInvite('wrong', EXPIRES_MS - 1)).toBe(false);
  });

  it('an offset expiry is read as that instant', () => {
    process.env.INVITE_CODE_SHA256 = sha256(CODE);
    process.env.INVITE_EXPIRES_AT = '2026-11-09T07:00:00-05:00';
    expect(readInviteEnv().invite?.expiresAt).toBe(EXPIRES_MS);
  });

  it.each([
    ['a hash that is not 64 hex characters', { INVITE_CODE_SHA256: 'abc123', INVITE_EXPIRES_AT: EXPIRES }, 'INVITE_CODE_SHA256'],
    ['the plain code instead of its hash', { INVITE_CODE_SHA256: CODE, INVITE_EXPIRES_AT: EXPIRES }, 'INVITE_CODE_SHA256'],
    ['no expiry', { INVITE_CODE_SHA256: sha256(CODE) }, 'INVITE_EXPIRES_AT'],
    ['an expiry without a time zone', { INVITE_CODE_SHA256: sha256(CODE), INVITE_EXPIRES_AT: '2026-11-09T12:00:00' }, 'INVITE_EXPIRES_AT'],
    ['an expiry that is not a date', { INVITE_CODE_SHA256: sha256(CODE), INVITE_EXPIRES_AT: 'sunday noon' }, 'INVITE_EXPIRES_AT'],
  ])('%s: off, reported by name only, the server still starts', (_label, vars, name) => {
    Object.assign(process.env, vars);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { invite, problem } = readInviteEnv();
    expect(invite).toBeNull();
    expect(problem).toContain(name);
    expect(serverEnv().invite).toBeNull();
    expect(verifyInvite(CODE, 0)).toBe(false);
    // Logged once, by name; never the value.
    expect(errors).toHaveBeenCalledTimes(1);
    const line = String(errors.mock.calls[0]?.[0]);
    expect(line).toContain(name);
    for (const value of Object.values(vars)) expect(line).not.toContain(value);
    serverEnv();
    expect(errors).toHaveBeenCalledTimes(1);
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

describe('scripts/make-invite.mjs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lp-make-invite-'));
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));
  const run = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-invite.mjs'), ...args], { cwd, encoding: 'utf8' });
  const parse = (stdout: string) => Object.fromEntries(stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

  it('prints a fresh 32-byte base64url code and its SHA-256, and writes nothing', () => {
    const a = run();
    expect(a.status).toBe(0);
    expect(a.stderr).toBe('');
    const out = parse(a.stdout);
    expect(Object.keys(out)).toEqual(['JOIN_CODE', 'INVITE_CODE_SHA256']);
    expect(out.JOIN_CODE).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(out.JOIN_CODE as string, 'base64url')).toHaveLength(32);
    expect(out.INVITE_CODE_SHA256).toBe(sha256(out.JOIN_CODE as string));
    // The server accepts it as configured.
    expect(inviteMatches(out.JOIN_CODE as string, { sha256: Buffer.from(out.INVITE_CODE_SHA256 as string, 'hex'), expiresAt: Infinity }, 0)).toBe(true);
    expect(parse(run().stdout).JOIN_CODE).not.toBe(out.JOIN_CODE);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it('with a host, also prints the link (fragment, /signin)', () => {
    const out = parse(run('https://lp.example/some/path').stdout);
    expect(out.JOIN_LINK).toBe(`https://lp.example/signin#join=${out.JOIN_CODE}`);
  });

  it('refuses a host that is not an http(s) URL', () => {
    const r = run('lp.example');
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });
});
