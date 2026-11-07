// The desk request table's pure model (components/desk/table/table-model.ts): the columns, the Logged by
// and Post cells, the times (F1's helpers), and the sentence a screen reader hears for each row. Synthetic.
import { describe, expect, it } from 'vitest';
import {
  TABLE_COLUMNS,
  compactStaffName,
  compactTeam,
  friendCell,
  loggedByPhrase,
  loggedByShort,
  outboxRow,
  postCell,
  rowTimes,
  searchRowLabel,
  tableRowLabel,
} from '@/components/desk/table/table-model';
import { outboxDisplay, outboxRowLabel } from '@/components/list/list-helpers';
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { STUB_SESSION, stubRows } from '@/lib/client/stub-data';
import { formatCreatedTime } from '@/lib/format';

const NOW = Date.parse('2026-11-07T03:10:00Z');
const TZ = 'America/New_York';
const rows = stubRows(NOW);
const byCase = (n: number) => rows.find((r) => r.caseNumber === n) as RequestSummary;
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function outboxItem(over: Partial<OutboxItem> = {}): OutboxItem {
  const id = over.mutationId ?? '0b5a3c2e-8d4f-4a1b-9c7e-2f6d8a1b3c4d';
  return {
    mutationId: id,
    payload: { clientMutationId: id, reportingLocation: 'FA 3 – Kinetic', name: 'TEST-T Queued', age: '30', gender: 'Male' },
    photos: [],
    serverId: null,
    caseNumber: null,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    operator: { staffName: 'Dana Kim', team: 'GC/HX - Dispatch', staff: STUB_SESSION.staff },
    createdAt: NOW - 60_000,
    source: 'app',
    ...over,
  };
}

describe('columns', () => {
  it('are the mockup order: #, Friend, Status, Post, Created, Updated, Logged by; Post and Logged by are the wide ones', () => {
    expect(TABLE_COLUMNS.map((c) => c.label)).toEqual(['#', 'Friend', 'Status', 'Post', 'Created', 'Updated', 'Logged by']);
    expect(TABLE_COLUMNS.filter((c) => c.wide).map((c) => c.key)).toEqual(['post', 'by']);
    expect(TABLE_COLUMNS.filter((c) => c.end).map((c) => c.key)).toEqual(['created', 'updated']);
  });
});

describe('Logged by', () => {
  it('compacts a name to the first name and the last initial', () => {
    expect(compactStaffName('Dana Kim')).toBe('Dana K.');
    expect(compactStaffName('  Rae   Chen ')).toBe('Rae C.');
    expect(compactStaffName('Rae')).toBe('Rae');
    expect(compactStaffName('Dani V.')).toBe('Dani V.');
    expect(compactStaffName('Ana María López')).toBe('Ana L.');
    expect(compactStaffName('lee park')).toBe('lee P.');
    expect(compactStaffName('Sam 2')).toBe('Sam 2');
    expect(compactStaffName('')).toBe('');
  });

  it("uses the mockup's short team names, aliases included; any other team as typed", () => {
    expect(compactTeam('GC/HX - Special Operations/Med Transpo')).toBe('Transpo');
    expect(compactTeam('GC/HX - Base')).toBe('Base');
    expect(compactTeam('GC/HX - Dispatch')).toBe('Dispatch');
    expect(compactTeam('Medical')).toBe('Medical');
    expect(compactTeam('med transpo')).toBe('Transpo');
    expect(compactTeam('GCHX Base')).toBe('Base');
    expect(compactTeam('Volunteer Desk')).toBe('Volunteer Desk');
  });

  it('shows "Dana K. · Transpo" and says the whole attribution', () => {
    expect(loggedByShort('Dana Kim · GC/HX - Special Operations/Med Transpo')).toBe('Dana K. · Transpo');
    expect(loggedByShort('Lee Park • GC/HX - Base')).toBe('Lee P. · Base');
    expect(loggedByShort('Legacy name only')).toBe('Legacy O.');
    expect(loggedByShort('')).toBe('');
    expect(loggedByPhrase('Dana Kim · GC/HX - Special Operations/Med Transpo')).toBe('Dana Kim, GCHX Med Transpo');
    expect(loggedByPhrase('Sam Ortiz · Medical')).toBe('Sam Ortiz, Medical');
    expect(loggedByPhrase('Legacy name only')).toBe('Legacy name only');
  });
});

describe('cells', () => {
  it('Post is the full post name, and an Other location never reads like a post', () => {
    expect(postCell({ reportingLocation: 'FA 4 – Oasis', otherLocation: null })).toBe('FA 4 – Oasis');
    expect(postCell({ reportingLocation: 'Other', otherLocation: 'Base' })).toBe('Other · Base');
    expect(postCell({ reportingLocation: 'Other', otherLocation: null })).toBe('Other');
    expect(postCell({ reportingLocation: 'FA 3', otherLocation: null })).toBe('FA 3');
  });

  it('Friend is the name (or "No name") and the muted age / sex, free-text age kept', () => {
    expect(friendCell(byCase(1012))).toEqual({ name: 'Kayla Martinez', ageGender: '19 F' });
    expect(friendCell({ name: '', age: 'mid-20s', gender: 'Other' })).toEqual({ name: 'No name', ageGender: 'mid-20s' });
    expect(friendCell({ name: 'A.B.', age: null, gender: null })).toEqual({ name: 'A.B.', ageGender: '' });
  });

  it('times are F1\'s: created "h:mm AM/PM" (weekday for an earlier day), updated relative or "—"', () => {
    const fresh = rowTimes(byCase(1013), NOW, TZ);
    expect(fresh.created).toBe(formatCreatedTime(byCase(1013).createdAt, NOW, TZ));
    expect(fresh.created).toMatch(/^\d{1,2}:\d\d (AM|PM)$/);
    expect(fresh.updated).toBe('—');
    expect(fresh.updatedSaid).toBe('not updated yet');
    expect(fresh.updatedTitle).toBeNull();

    const answered = rowTimes(byCase(1004), NOW, TZ);
    expect(answered.updated).toBe('3m');
    expect(answered.updatedSaid).toBe('updated 3 minutes ago');
    expect(answered.updatedTitle).toMatch(/^Nov 6, \d{1,2}:\d\d (AM|PM)$/);

    const yesterday = rowTimes(byCase(1000), NOW, TZ);
    expect(yesterday.created).toMatch(/^Thu \d{1,2}:\d\d (AM|PM)$/);
    expect(yesterday.updated).toBe('1d');

    // Only its creator's photo uploads while logging: still "not updated".
    const photosOnly = { ...byCase(1013), rowVersion: 2, photoCount: 2, updatedAt: iso(0), updatedBy: byCase(1013).createdBy };
    expect(rowTimes(photosOnly, NOW, TZ).updated).toBe('—');
  });
});

describe('sentences', () => {
  it('a row says number, name and age, status, both times, post and who logged it', () => {
    const row = byCase(1013);
    const times = rowTimes(row, NOW, TZ);
    expect(tableRowLabel(row, times)).toBe(
      `LP-1013, T.R., 24 M, Waiting for check, created ${times.created}, not updated yet, FA 4 – Oasis, logged by Lee Park, GCHX Base`,
    );
    const inMedical = byCase(1004);
    expect(tableRowLabel(inMedical, rowTimes(inMedical, NOW, TZ))).toMatch(
      /^LP-1004, S\.L\., 20 F, Located, friend coming, created .+, updated 3 minutes ago, FA 3 – Kinetic, logged by Dana Kim, Dispatch$/,
    );
    const nameless = { ...row, name: '', age: null, gender: null };
    expect(tableRowLabel(nameless, times)).toMatch(/^LP-1013, No name, Waiting for check, /);
  });

  it('a search result adds the matched text when the match is not the name or number', () => {
    const row = byCase(998);
    const times = rowTimes(row, NOW, TZ);
    expect(searchRowLabel(row, times, '')).toBe(`${tableRowLabel(row, times)}.`);
    expect(searchRowLabel(row, times, 'Black tank, pink hair')).toBe(`${tableRowLabel(row, times)}. Black tank, pink hair`);
  });

  it('an unsent request reads exactly as on the phone, with no number until the server gives one', () => {
    const item = outboxItem();
    const created = formatCreatedTime(item.createdAt, NOW, TZ);
    const m = outboxRow(item, created);
    expect(m.said).toBe(outboxRowLabel(outboxDisplay(item), created));
    expect(m.said).toMatch(/^TEST-T Queued, 30 M, .+\. Waiting to send, FA 3, Not sent\.$/);
    expect(m).toMatchObject({ number: '', name: 'TEST-T Queued', ageGender: '30 M', post: 'FA 3 – Kinetic', by: 'Dana K. · Dispatch', needsAttention: false, label: 'Waiting to send' });

    const fix = outboxRow(outboxItem({ state: 'needs_attention', caseNumber: 1020, payload: { clientMutationId: 'x', reportingLocation: 'Other', otherLocation: 'Gate 9' } }), created);
    expect(fix).toMatchObject({ number: '1020', name: 'No name', post: 'Other · Gate 9', needsAttention: true, label: 'Needs attention' });
    expect(fix.said).toMatch(/Open to fix and resend\.$/);
  });
});
