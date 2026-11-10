// (Grace period, 2026-11-10) For 24 h after End an event keeps its staff password and join link:
//   * the Reopen sheet's case (components/events/format.ts reopenKeeps) and its time left;
//   * the End / Reopen sheets' lines stay true in both cases;
//   * sign-in compares a held event's hash (its match is the Ended answer, stage archived);
//   * the uniqueness rule counts a held hash, returns what it compared, and the password write re-checks under a
//     lock: a write refused with secrets_changed checks again (three rounds at most). The database is mocked.
import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatLeft, reopenKeeps, spokenLeft } from '@/components/events/format';
import { FACT } from '@/components/events/StageSheets';

const db = vi.hoisted(() => ({
  secrets: { lead: null as string | null, leadVersion: 1, events: [] as Array<{ id: string; stage: string; hash: string }>, retired: [] as string[] },
  setCalls: [] as Array<Record<string, unknown>>,
  setAnswers: [] as Array<'ok' | 'secrets_changed'>,
  onSet: null as null | (() => void),
}));

vi.mock('@/lib/server/supabase', async () => {
  const { mapDbError } = await import('@/lib/server/errors');
  return {
    db: () => ({}),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'lp_auth_secrets') return structuredClone(db.secrets);
      if (fn === 'lp_event_set_password') {
        db.setCalls.push(args);
        db.onSet?.();
        const answer = db.setAnswers.shift() ?? 'ok';
        if (answer === 'secrets_changed') throw mapDbError({ code: 'P0409', message: 'secrets_changed', hint: 'secrets_changed', details: 'field:password' });
        return { id: args.p_event, stage: 'live' };
      }
      throw new Error(`unexpected ${fn}`);
    },
  };
});

const { assertSecretUnique, matchPassword, setStaffPassword } = await import('@/lib/server/events');

const H = 3600_000;
const NOW = Date.parse('2026-11-12T20:00:00Z');

describe('reopenKeeps, formatLeft, spokenLeft', () => {
  const ended = { hasStaffPassword: true, joinLinkExpiresAt: '2026-11-18T00:00:00Z' };
  it('inside the 24 h: password and join link kept, with the time left', () => {
    const k = reopenKeeps({ ...ended, holdUntil: new Date(NOW + 23 * H + 12 * 60_000 + 5_000).toISOString() }, NOW);
    expect(k).toMatchObject({ held: true, password: true, joinLink: true });
    expect(formatLeft(k.leftMs)).toBe('23 h 12 m');
    expect(spokenLeft(k.leftMs)).toBe('23 hours 12 minutes');
  });
  it('outside them (holdUntil null, or passed while the sheet was open): new ones needed, no time left', () => {
    expect(reopenKeeps({ ...ended, holdUntil: null }, NOW)).toEqual({ held: false, leftMs: 0, password: false, joinLink: false });
    expect(reopenKeeps({ ...ended, holdUntil: new Date(NOW - 1).toISOString() }, NOW)).toMatchObject({ held: false, password: false, joinLink: false });
    expect(formatLeft(0)).toBe('');
  });
  it('inside them, only what the event had: no password set, or a join link already expired, is not kept', () => {
    const holdUntil = new Date(NOW + H).toISOString();
    expect(reopenKeeps({ holdUntil, hasStaffPassword: false, joinLinkExpiresAt: null }, NOW)).toMatchObject({ held: true, password: false, joinLink: false });
    expect(reopenKeeps({ holdUntil, hasStaffPassword: true, joinLinkExpiresAt: new Date(NOW - 1).toISOString() }, NOW)).toMatchObject({ password: true, joinLink: false });
  });
  it('short and spoken forms at the edges', () => {
    expect(formatLeft(42 * 60_000 + 1)).toBe('42 m');
    expect(formatLeft(30_000)).toBe('<1 m');
    expect(formatLeft(H)).toBe('1 h 0 m');
    expect(spokenLeft(H)).toBe('1 hour');
    expect(spokenLeft(61 * 60_000)).toBe('1 hour 1 minute');
    expect(spokenLeft(10_000)).toBe('less than a minute');
  });
});

describe('the sheets\' line of fact', () => {
  it('End: signed out, nothing deleted, reopen within 24 hours with the same password', () => {
    expect(FACT.end).toMatch(/signed out/);
    expect(FACT.end).toMatch(/nothing is deleted/);
    expect(FACT.end).toMatch(/within 24 hours it can be reopened with the same password/);
  });
  it('Reopen: true whether or not the password is kept (the rows say which)', () => {
    expect(FACT.reopen).toBe('Open requests resume as they were; staff sign in again.');
    expect(FACT.reopen).not.toMatch(/password|link/);
  });
});

describe('sign-in and the uniqueness rule with a held hash (bcrypt, cost 4 here)', () => {
  const pw = { lead: 'lead-passcode-1', running: 'running-pass-1', held: 'held-pass-1' };
  let hash: Record<keyof typeof pw, string>;
  beforeEach(async () => {
    hash = {
      lead: await bcrypt.hash(pw.lead, 4),
      running: await bcrypt.hash(pw.running, 4),
      held: await bcrypt.hash(pw.held, 4),
    };
    db.secrets = {
      lead: hash.lead,
      leadVersion: 3,
      events: [
        { id: 'run', stage: 'live', hash: hash.running },
        { id: 'held', stage: 'archived', hash: hash.held },
      ],
      retired: [],
    };
    db.setCalls = [];
    db.setAnswers = [];
    db.onSet = null;
  });

  it('a held event\'s password matches its event (stage archived: the route answers Ended)', async () => {
    expect(await matchPassword(pw.held)).toEqual({ kind: 'event', eventId: 'held', stage: 'archived' });
    expect(await matchPassword(pw.running)).toEqual({ kind: 'event', eventId: 'run', stage: 'live' });
    expect(await matchPassword(pw.lead)).toEqual({ kind: 'lead', version: 3 });
    expect(await matchPassword('nope-nope-1')).toBeNull();
  });

  it('a held password may not be another event\'s, nor the lead passcode; its own event may keep it', async () => {
    await expect(assertSecretUnique(pw.held, { kind: 'event', eventId: 'other' })).rejects.toMatchObject({ code: 'invalid', extra: { field: 'password' } });
    await expect(assertSecretUnique(pw.held, { kind: 'lead' })).rejects.toMatchObject({ code: 'invalid', extra: { field: 'passcode' } });
    await expect(assertSecretUnique(pw.held, { kind: 'event', eventId: 'held' })).resolves.toEqual([hash.lead, hash.running]);
    await expect(assertSecretUnique('fresh-pass-1', { kind: 'event', eventId: 'other' })).resolves.toEqual([hash.lead, hash.running, hash.held]);
  });

  it('setStaffPassword sends what it compared; on secrets_changed it checks again with what is in force now', async () => {
    const row = await setStaffPassword('other', 'fresh-pass-1');
    expect(row).toMatchObject({ id: 'other' });
    expect(db.setCalls).toHaveLength(1);
    expect(db.setCalls[0]!.p_checked).toEqual([hash.lead, hash.running, hash.held]);
    expect(await bcrypt.compare('fresh-pass-1', String(db.setCalls[0]!.p_hash))).toBe(true);

    // Between the check and the write, a reopen kept an event's password that equals this one: the write is
    // refused, the second check sees it and refuses with 422.
    db.setCalls = [];
    db.secrets.events = [{ id: 'run', stage: 'live', hash: hash.running }];
    db.setAnswers = ['secrets_changed'];
    db.onSet = () => {
      db.secrets.events.push({ id: 'reopened', stage: 'live', hash: hash.held });
    };
    await expect(setStaffPassword('other', pw.held)).rejects.toMatchObject({ code: 'invalid', extra: { field: 'password' } });
    expect(db.setCalls).toHaveLength(1);
  });

  it('gives up after three refused writes (409), never writing unchecked', async () => {
    db.setAnswers = ['secrets_changed', 'secrets_changed', 'secrets_changed'];
    await expect(setStaffPassword('other', 'fresh-pass-2')).rejects.toMatchObject({ code: 'conflict', status: 409 });
    expect(db.setCalls).toHaveLength(3);
    for (const c of db.setCalls) expect(Array.isArray(c.p_checked)).toBe(true);
  });
});
