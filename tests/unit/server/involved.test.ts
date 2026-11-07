// involvedStaff (contract C, F4): lp_involved_staff (the Messages release) when it is there; otherwise —
// PGRST202 / 42883 (no such function), any other error, a network failure or an empty answer — the fallback
// lp_activity_fallback_staff (logger + answerer). Never throws. The database is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  involved: { data: null as unknown, error: null as unknown, throws: false },
  fallback: ['Dana Kim · GC/HX - Dispatch', 'Rae Chen · Medical'] as unknown,
  fallbackThrows: false,
  calls: [] as string[],
}));

vi.mock('@/lib/server/supabase', () => ({
  db: () => ({
    rpc: async (fn: string) => {
      db.calls.push(fn);
      if (db.involved.throws) throw new TypeError('fetch failed');
      return { data: db.involved.data, error: db.involved.error };
    },
  }),
  rpc: async (fn: string) => {
    db.calls.push(fn);
    if (fn === 'lp_activity_fallback_staff') {
      if (db.fallbackThrows) throw new Error('down');
      return db.fallback;
    }
    if (fn === 'lp_push_new_request_staff') return ['rae chen · medical'];
    throw new Error(`unexpected ${fn}`);
  },
}));

const { involvedStaff, newRequestStaff, staffList } = await import('@/lib/server/involved');
const ID = '0f0f0f0f-0000-4000-8000-0000000000d4';

beforeEach(() => {
  db.involved = { data: null, error: null, throws: false };
  db.fallback = ['Dana Kim · GC/HX - Dispatch', 'Rae Chen · Medical'];
  db.fallbackThrows = false;
  db.calls = [];
});

describe('involvedStaff', () => {
  it('uses lp_involved_staff when it answers (setof text, or rows of one column)', async () => {
    db.involved.data = ['Dana Kim · GC/HX - Dispatch', 'Sam Lee · GC/HX - Base'];
    expect(await involvedStaff(ID)).toEqual(['Dana Kim · GC/HX - Dispatch', 'Sam Lee · GC/HX - Base']);
    expect(db.calls).toEqual(['lp_involved_staff']);
    db.involved.data = [{ lp_involved_staff: 'Dana Kim · GC/HX - Dispatch' }];
    expect(await involvedStaff(ID)).toEqual(['Dana Kim · GC/HX - Dispatch']);
  });

  it.each([
    ['PGRST202 (not in the schema cache)', { code: 'PGRST202', message: 'Could not find the function' }],
    ['42883 (undefined function)', { code: '42883', message: 'function does not exist' }],
    ['any other error', { code: 'XX000', message: 'boom' }],
  ])('falls back to logger + answerer on %s', async (_name, error) => {
    db.involved.error = error;
    expect(await involvedStaff(ID)).toEqual(['Dana Kim · GC/HX - Dispatch', 'Rae Chen · Medical']);
    expect(db.calls).toEqual(['lp_involved_staff', 'lp_activity_fallback_staff']);
  });

  it('falls back on a network failure and on an empty answer', async () => {
    db.involved.throws = true;
    expect(await involvedStaff(ID)).toHaveLength(2);
    db.involved = { data: [], error: null, throws: false };
    expect(await involvedStaff(ID)).toHaveLength(2);
  });

  it('never throws, even when the fallback fails too', async () => {
    db.involved.error = { code: 'PGRST202' };
    db.fallbackThrows = true;
    await expect(involvedStaff(ID)).resolves.toEqual([]);
  });

  it('newRequestStaff reads the New requests switch', async () => {
    expect(await newRequestStaff()).toEqual(['rae chen · medical']);
  });

  it('staffList keeps strings only', () => {
    expect(staffList(['a', '', '  ', 3, null, { x: 'b' }, { x: 'c', y: 'd' }])).toEqual(['a', 'b']);
    expect(staffList(null)).toEqual([]);
  });
});
