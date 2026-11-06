// Search over the free-text age (Jeffrey, 2026-11-06 10:31: "for age, they can put mid-20s"). Synthetic rows.
import { describe, expect, it } from 'vitest';
import type { RequestSummary } from '@/lib/api-types';
import { searchRequests } from '@/lib/client/selectors';
import { stubRows } from '@/lib/client/stub-data';

const NOW = Date.parse('2026-11-07T03:10:00Z');
const base = stubRows(NOW);
const at = (n: number) => base.find((r) => r.caseNumber === n) as RequestSummary;
const rows: RequestSummary[] = [
  { ...at(1013), age: 'mid-20s' },
  { ...at(1012), age: 'Early 20S' },
  ...base.filter((r) => r.caseNumber !== 1013 && r.caseNumber !== 1012),
];

describe('search: free-text age', () => {
  it('matches the age text, case-insensitive, with the age as the highlighted snippet', () => {
    const hits = searchRequests(rows, 'mid-20s');
    expect(hits.map((h) => [h.row.caseNumber, h.field, h.text, h.ranges])).toEqual([[1013, 'age', 'mid-20s', [[0, 7]]]]);
    expect(searchRequests(rows, '20s').map((h) => h.row.caseNumber).sort()).toEqual([1012, 1013]);
    expect(searchRequests(rows, 'early').map((h) => [h.row.caseNumber, h.field])).toEqual([[1012, 'age']]);
  });

  it('a field above it still wins (its snippet is shown), and LP-number queries never match ages', () => {
    // "Kayla" is the name of LP-1012; the name hit is reported, not the age.
    expect(searchRequests(rows, 'kayla')[0]?.field).toBe('name');
    // "24" reads as an LP number: no LP-24 and no LP-24xx, and no age hit either (LP-1013's old age was 24).
    const numeric = rows.map((r) => (r.caseNumber === 1011 ? { ...r, age: '24' } : r));
    expect(searchRequests(numeric, '24').filter((h) => h.field === 'age')).toEqual([]);
    expect(searchRequests(numeric, 'LP-1011').map((h) => h.field)).toEqual(['caseNumber']);
  });

  it('a row cached before age became text (age still a number) never throws', () => {
    // The smallint → text change bumped neither updated_at nor row_version, so delta sync keeps such rows,
    // and a PATCH queued by an older client can put a number into an overlay.
    const cached = base.map((r) => ({ ...r, age: 24 as unknown as string }));
    expect(searchRequests(cached, 'kayla').map((h) => [h.row.caseNumber, h.field])).toEqual([[1012, 'name']]);
    // Every field is checked, the numeric age last: no match anywhere, no throw.
    expect(searchRequests(cached, 'mid-20s')).toEqual([]);
    expect(searchRequests(cached, 'LP-1012').map((h) => h.row.caseNumber)).toEqual([1012]);
  });
});
