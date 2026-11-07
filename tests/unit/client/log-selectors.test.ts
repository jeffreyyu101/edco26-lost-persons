// All requests, log option B (2026-11-06): open requests first, every closed one (Not found in medical included)
// folded; My requests open first, then the closed ones. Synthetic stub rows only.
import { describe, expect, it } from 'vitest';
import type { RequestSummary } from '@/lib/api-types';
import { logSections, mineSections, sortNewestFirst, splitOpenClosed } from '@/lib/client/selectors';
import { STUB_SESSION, stubRows } from '@/lib/client/stub-data';
import { STATUS, statusBucket } from '@/lib/domain';

const NOW = Date.parse('2026-11-07T03:10:00Z');
const rows = stubRows(NOW);
const cases = (list: readonly RequestSummary[]) => list.map((r) => r.caseNumber);

describe('log sections (option B)', () => {
  it('splits into open and closed, newest created first in each', () => {
    const { open, closed } = logSections([...rows].reverse());
    expect(cases(open)).toEqual([1013, 1012, 1011, 1010, 1007, 1004, 1005]);
    expect(cases(closed)).toEqual([1009, 1008, 1003, 1006, 1002, 1001, 1000, 999, 998, 997, 996, 995, 994, 993]);
    expect(open.length + closed.length).toBe(rows.length);
  });

  it('Not found in medical is closed; Waiting, In medical and legacy Bring friend are open', () => {
    const { open, closed } = logSections(rows);
    expect(closed.filter((r) => r.status === STATUS.notInMedical).map((r) => r.caseNumber)).toEqual([1009, 1008]);
    expect(open.every((r) => statusBucket(r.status) === 'open')).toBe(true);
    expect(open.some((r) => r.status === STATUS.legacyBringFriend)).toBe(true);
    // An unknown legacy status is closed (no actions, greyed).
    const legacy = { ...rows[0]!, id: 'legacy', status: 'Found – Transported' };
    expect(splitOpenClosed([legacy]).closed).toEqual([legacy]);
  });

  it('keeps the order it is given (the store already sorts newest first)', () => {
    const sorted = sortNewestFirst(rows);
    const { open } = splitOpenClosed(sorted);
    expect(cases(open)).toEqual(cases(sorted.filter((r) => statusBucket(r.status) === 'open')));
    expect(splitOpenClosed([])).toEqual({ open: [], closed: [] });
  });

  it('My requests: open first, then the closed ones, each newest update first', () => {
    const { open, closed } = mineSections(rows, new Set(), STUB_SESSION.staff);
    // Dana Kim created 1012, 1009, 1004, 1002, 1000, 994.
    expect(cases(open)).toEqual([1004, 1012]);
    expect(cases(closed)).toEqual([1009, 1002, 1000, 994]);
  });
});
