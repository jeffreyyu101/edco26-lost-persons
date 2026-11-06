// Search over the free-text age (Jeffrey, 2026-11-06 10:31: "for age, they can put mid-20s"). Synthetic rows.
import { describe, expect, it } from 'vitest';
import type { RequestSummary } from '@/lib/api-types';
import { searchRequests } from '@/lib/client/selectors';
import { stubRows } from '@/lib/client/stub-data';
import { mergeRows, normalizeRow, overlayForPatch, replaceAll } from '@/lib/client/sync-merge';

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
});

// Rows cached on a phone before the deploy (and a pending edit from the form) can still hold a number.
describe('search: a numeric age from before the free-text change', () => {
  const numeric = (r: RequestSummary, age: number) => ({ ...r, age: age as unknown as string });

  it('a text query over rows with a numeric age never throws (the search guards on its own)', () => {
    const legacy = base.map((r) => numeric(r, 24));
    expect(() => searchRequests(legacy, 'zebra')).not.toThrow();
    expect(searchRequests(legacy, 'zebra')).toEqual([]);
    expect(() => searchRequests([numeric(at(1013), 0), numeric(at(1012), 19)], 'x')).not.toThrow();
    // Other fields still match as before.
    expect(searchRequests(legacy, 'kayla').map((h) => [h.row.caseNumber, h.field])).toEqual([[1012, 'name']]);
  });

  it('rows entering client state are texted: merge, full fetch, edit overlay', () => {
    const row = numeric(at(1013), 24);
    expect(normalizeRow(row).age).toBe('24');
    expect(normalizeRow(at(1012))).toBe(at(1012)); // already text: same object
    expect(normalizeRow({ ...at(1012), age: null }).age).toBeNull();
    expect(normalizeRow(numeric(at(1012), Number.NaN)).age).toBeNull();
    expect(mergeRows(new Map(), [row])?.get(row.id)?.age).toBe('24');
    expect(replaceAll(new Map(), [row], new Set()).get(row.id)?.age).toBe('24');
    // An equal-version re-delivery of the same numeric row keeps the stored (texted) row's identity.
    const stored = new Map([[row.id, normalizeRow(row)]]);
    expect(mergeRows(stored, [row])).toBeNull();
    expect(replaceAll(stored, [row], new Set()).get(row.id)).toBe(stored.get(row.id));
    expect(overlayForPatch(at(1013), { age: 24 }).age).toBe('24');
    expect(overlayForPatch(at(1013), { age: ' mid-20s ' }).age).toBe('mid-20s');
  });
});
