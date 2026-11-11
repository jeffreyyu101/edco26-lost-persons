// (Events, lead screens) components/events/format.ts.
import { describe, expect, it } from 'vitest';
import { formatDates, hourLabel, initials, todayIso, zoneLabel, zoneOptions } from '@/components/events/format';

describe('formatDates', () => {
  it('reads like the mockups', () => {
    expect(formatDates('2026-11-14', '2026-11-15')).toBe('Nov 14–15');
    expect(formatDates('2026-11-14', '2026-11-15', true)).toBe('Nov 14–15, 2026');
    expect(formatDates('2026-11-06', '2026-11-08')).toBe('Nov 6–8');
    expect(formatDates('2026-10-31', '2026-11-02')).toBe('Oct 31 – Nov 2');
    expect(formatDates('2026-11-14', '2026-11-14', true)).toBe('Nov 14, 2026');
    expect(formatDates('2026-12-31', '2027-01-01')).toBe('Dec 31, 2026 – Jan 1, 2027');
    expect(formatDates('bad', '2026-11-14')).toBe('');
  });
});

describe('zones and hours', () => {
  it('names the common zones', () => {
    expect(zoneLabel('America/New_York')).toEqual({ label: 'Eastern', short: 'ET' });
    expect(zoneLabel('America/Argentina/Buenos_Aires')).toEqual({ label: 'America/Argentina/Buenos Aires', short: '' });
  });
  it('offers an unlisted current zone first', () => {
    expect(zoneOptions('America/New_York')[0]!.id).toBe('America/New_York');
    expect(zoneOptions('Asia/Kolkata')[0]!.id).toBe('Asia/Kolkata');
  });
  it('labels show-day hours', () => {
    expect(hourLabel(0)).toBe('12:00 AM');
    expect(hourLabel(6)).toBe('6:00 AM');
    expect(hourLabel(12)).toBe('12:00 PM');
    expect(hourLabel(23)).toBe('11:00 PM');
  });
});

describe('initials and dates', () => {
  it('takes two initials', () => {
    expect(initials('Warped Tour Orlando')).toBe('WT');
    expect(initials('EDC')).toBe('ED');
    expect(initials('  ')).toBe('?');
    expect(initials('über fest')).toBe('ÜF');
  });
  it('gives today as YYYY-MM-DD', () => {
    expect(todayIso(new Date(2026, 10, 9, 23, 59))).toBe('2026-11-09');
  });
});
