// Sign-in logic (components/signin/logic.ts): step-1 validity mirrors signInSchema, the request body,
// remembered identity, and how every POST /api/session response is shown. Synthetic names only.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_SECONDS,
  EMPTY_DRAFT,
  FORBIDDEN_CHAR_MESSAGE,
  MESSAGES,
  checkWho,
  draftFromIdentity,
  interpretSignInResponse,
  parseRetryAfter,
  rememberedIdentity,
  retryMinutes,
  signInBody,
  type WhoDraft,
} from '@/components/signin/logic';
import { TEAMS } from '@/lib/domain';
import { signInSchema } from '@/lib/validation';

const MED = 'GC/HX - Special Operations/Med Transpo';
const NOW = Date.parse('2026-11-06T23:00:00Z');

const draft = (over: Partial<WhoDraft>): WhoDraft => ({ ...EMPTY_DRAFT, ...over });

describe('checkWho (step 1, Continue)', () => {
  it('needs a 2+ character name and a team', () => {
    expect(checkWho(EMPTY_DRAFT).identity).toBeNull();
    expect(checkWho(draft({ name: 'D', team: MED })).identity).toBeNull();
    expect(checkWho(draft({ name: '  D  ', team: MED })).identity).toBeNull();
    expect(checkWho(draft({ name: 'Dana Kim' })).identity).toBeNull();
    expect(checkWho(draft({ name: 'Dana Kim', otherTeam: 'X' })).identity).toBeNull();
    expect(checkWho(draft({ name: 'DK', team: MED })).identity).toEqual({ name: 'DK', team: MED });
  });

  it('collapses whitespace like the server', () => {
    expect(checkWho(draft({ name: '  Dana   Kim ', team: MED })).identity).toEqual({ name: 'Dana Kim', team: MED });
    expect(checkWho(draft({ name: 'Dana Kim', otherTeam: '  Site   Ops ' })).identity).toEqual({ name: 'Dana Kim', team: 'Site Ops' });
  });

  it('maps a known alias typed as Other team to its canonical team (A28)', () => {
    expect(checkWho(draft({ name: 'Dana Kim', otherTeam: 'dispatch' })).identity?.team).toBe('GC/HX - Dispatch');
    expect(checkWho(draft({ name: 'Dana Kim', otherTeam: 'PREVENT' })).identity?.team).toBe('Prevent');
  });

  it('enforces the 60 / 80 code point limits', () => {
    expect(checkWho(draft({ name: 'a'.repeat(60), team: MED })).identity).not.toBeNull();
    expect(checkWho(draft({ name: 'a'.repeat(61), team: MED })).identity).toBeNull();
    expect(checkWho(draft({ name: '😀'.repeat(30), team: MED })).identity).not.toBeNull();
    expect(checkWho(draft({ name: 'Dana Kim', otherTeam: 'b'.repeat(80) })).identity).not.toBeNull();
    expect(checkWho(draft({ name: 'Dana Kim', otherTeam: 'b'.repeat(81) })).identity).toBeNull();
  });

  it('refuses the attribution separator and says why', () => {
    const name = checkWho(draft({ name: 'Dana · Kim', team: MED }));
    expect(name.identity).toBeNull();
    expect(name.nameError).toBe(FORBIDDEN_CHAR_MESSAGE);
    const team = checkWho(draft({ name: 'Dana Kim', otherTeam: 'Ops • North' }));
    expect(team.identity).toBeNull();
    expect(team.otherTeamError).toBe(FORBIDDEN_CHAR_MESSAGE);
    // A chosen card wins over stale Other text.
    expect(checkWho(draft({ name: 'Dana Kim', team: MED, otherTeam: 'Ops • North' })).otherTeamError).toBeNull();
  });

  it('never enables Continue for something signInSchema refuses, and agrees on the stored identity', () => {
    const cases: WhoDraft[] = [
      draft({ name: 'Dana Kim', team: MED }),
      ...TEAMS.map((t) => draft({ name: 'Sam Ortiz', team: t.value })),
      draft({ name: 'Rae', otherTeam: 'Site Ops' }),
      draft({ name: 'Rae', otherTeam: 'gchx base' }),
      draft({ name: 'Rae', otherTeam: 'Other' }),
      draft({ name: 'R', team: MED }),
      draft({ name: 'Rae\u0007', team: MED }),
      draft({ name: 'Rae', otherTeam: 'O' }),
      draft({ name: 'Rae ・ Lee', team: MED }),
      draft({ name: 'x'.repeat(61), team: MED }),
    ];
    for (const d of cases) {
      const { identity } = checkWho(d);
      if (!identity) continue;
      const parsed = signInSchema.safeParse(signInBody(identity, 'pw'));
      expect(parsed.success, JSON.stringify(d)).toBe(true);
      if (parsed.success) {
        expect(parsed.data.staffName).toBe(identity.name);
        expect(parsed.data.team).toBe(identity.team);
      }
    }
  });
});

describe('signInBody', () => {
  it('sends a card as the team', () => {
    expect(signInBody({ name: 'Dana Kim', team: MED }, 'secret')).toEqual({ staffName: 'Dana Kim', team: MED, password: 'secret' });
  });
  it('sends anything else as Other + otherTeam', () => {
    expect(signInBody({ name: 'Dana Kim', team: 'Prevent' }, 'secret')).toEqual({
      staffName: 'Dana Kim',
      team: 'Other',
      otherTeam: 'Prevent',
      password: 'secret',
    });
  });
});

describe('remembered identity and Change', () => {
  it('skips to step 2 only with both name and team', () => {
    expect(rememberedIdentity({ rememberedName: 'Dana Kim', rememberedTeam: MED })).toEqual({ name: 'Dana Kim', team: MED });
    expect(rememberedIdentity({ rememberedName: 'Dana Kim', rememberedTeam: null })).toBeNull();
    expect(rememberedIdentity({ rememberedName: null, rememberedTeam: MED })).toBeNull();
  });
  it('prefills step 1 with the card, or the Other text', () => {
    expect(draftFromIdentity({ name: 'Dana Kim', team: MED })).toEqual({ name: 'Dana Kim', team: MED, otherTeam: '' });
    expect(draftFromIdentity({ name: 'Dana Kim', team: 'Site Ops' })).toEqual({ name: 'Dana Kim', team: null, otherTeam: 'Site Ops' });
    expect(draftFromIdentity(null)).toEqual(EMPTY_DRAFT);
  });
});

describe('interpretSignInResponse', () => {
  const session = { staffName: 'Dana Kim', team: MED, staff: `Dana Kim · ${MED}`, expiresAt: '2026-11-07T11:00:00.000Z' };

  it('200 → signed in with the SessionInfo', () => {
    expect(interpretSignInResponse(200, session, null, NOW)).toEqual({ kind: 'ok', session });
  });
  it('200 with an unreadable body is still signed in (the cookie is set)', () => {
    expect(interpretSignInResponse(200, null, null, NOW)).toEqual({ kind: 'ok', session: null });
    expect(interpretSignInResponse(200, { staffName: 1 }, null, NOW)).toEqual({ kind: 'ok', session: null });
  });
  it('401 → incorrect password', () => {
    expect(interpretSignInResponse(401, { error: { code: 'unauthorized', message: 'x' } }, null, NOW)).toEqual({ kind: 'password' });
  });
  it('429 → retry time from the body, then Retry-After, then the window', () => {
    const body = { error: { code: 'rate_limited', message: 'x', retryAfterSeconds: 125 } };
    expect(interpretSignInResponse(429, body, '600', NOW)).toEqual({ kind: 'rate_limited', retryAfterSeconds: 125 });
    expect(interpretSignInResponse(429, { error: { code: 'rate_limited', message: 'x' } }, '600', NOW)).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 600,
    });
    expect(interpretSignInResponse(429, null, null, NOW)).toEqual({ kind: 'rate_limited', retryAfterSeconds: DEFAULT_RETRY_SECONDS });
    expect(interpretSignInResponse(429, { error: { retryAfterSeconds: 0 } }, null, NOW)).toEqual({ kind: 'rate_limited', retryAfterSeconds: 1 });
  });
  it('400 / 422 → the server message (or a short fallback)', () => {
    expect(interpretSignInResponse(422, { error: { code: 'invalid', message: 'Name: 2–60 characters' } }, null, NOW)).toEqual({
      kind: 'invalid',
      message: 'Name: 2–60 characters',
    });
    expect(interpretSignInResponse(400, {}, null, NOW)).toEqual({ kind: 'invalid', message: 'Check your name and team' });
    expect(interpretSignInResponse(400, { error: { message: 'y'.repeat(500) } }, null, NOW)).toEqual({
      kind: 'invalid',
      message: 'Check your name and team',
    });
  });
  it('403 → forbidden; 5xx and anything else → server', () => {
    expect(interpretSignInResponse(403, { error: { code: 'bad_origin', message: 'x' } }, null, NOW)).toEqual({ kind: 'forbidden' });
    expect(interpretSignInResponse(503, { error: { code: 'unavailable', message: 'x', id: 'e1' } }, null, NOW)).toEqual({ kind: 'server' });
    expect(interpretSignInResponse(404, null, null, NOW)).toEqual({ kind: 'server' });
    expect(interpretSignInResponse(302, null, null, NOW)).toEqual({ kind: 'server' });
  });
});

describe('retry timing', () => {
  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter(' 90 ', NOW)).toBe(90);
    expect(parseRetryAfter(new Date(NOW + 61_000).toUTCString(), NOW)).toBe(61);
    expect(parseRetryAfter(new Date(NOW - 5_000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfter('soon', NOW)).toBeNull();
  });
  it('shows whole minutes, rounded up, at least 1', () => {
    expect(retryMinutes(0)).toBe(1);
    expect(retryMinutes(1)).toBe(1);
    expect(retryMinutes(60)).toBe(1);
    expect(retryMinutes(61)).toBe(2);
    expect(retryMinutes(899)).toBe(15);
    expect(MESSAGES.rateLimited(retryMinutes(540))).toBe('Too many attempts. Try again in 9 min');
  });
});
