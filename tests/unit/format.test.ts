import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVENT_TIMEZONE,
  eventDate,
  formatAuditTime,
  formatCaseNumber,
  formatClock,
  formatCsvTime,
  formatDuration,
  formatListTime,
  isSameEventDay,
  minutesSince,
  parseCaseNumberQuery,
  retryMinutes,
} from '@/lib/format';

// 2026-11-07T04:10:00Z is Fri Nov 6, 11:10 PM in America/New_York (EST, UTC−5 after Nov 1).
const FRI_2310 = '2026-11-07T04:10:00.123456+00:00';
const FRI_0958 = '2026-11-06T14:58:00Z';
const THU_2350 = '2026-11-06T04:50:00Z';
const SAT_0015 = '2026-11-07T05:15:00Z';

describe('case numbers', () => {
  it('formats LP numbers', () => {
    expect(formatCaseNumber(1004)).toBe('LP-1004');
    expect(formatCaseNumber(998)).toBe('LP-0998');
    expect(formatCaseNumber(12345)).toBe('LP-12345');
  });

  it('parses search queries', () => {
    expect(parseCaseNumberQuery('1012')).toBe(1012);
    expect(parseCaseNumberQuery('LP-1012')).toBe(1012);
    expect(parseCaseNumberQuery(' lp1012 ')).toBe(1012);
    expect(parseCaseNumberQuery('lp 0998')).toBe(998);
    expect(parseCaseNumberQuery('pink')).toBeNull();
    expect(parseCaseNumberQuery('LP-')).toBeNull();
  });
});

describe('event timezone', () => {
  it('defaults to America/New_York', () => {
    expect(DEFAULT_EVENT_TIMEZONE).toBe('America/New_York');
  });

  it('uses the event day, not UTC', () => {
    expect(eventDate(FRI_2310)).toBe('2026-11-06');
    expect(isSameEventDay(FRI_2310, FRI_0958)).toBe(true);
    expect(isSameEventDay(FRI_2310, SAT_0015)).toBe(false);
    expect(eventDate(FRI_2310, 'UTC')).toBe('2026-11-07');
  });

  it('shows h:mm for today and a weekday prefix otherwise', () => {
    expect(formatClock(FRI_2310)).toBe('11:10');
    expect(formatListTime(FRI_0958, FRI_2310)).toBe('9:58');
    expect(formatListTime(THU_2350, FRI_2310)).toBe('Thu 11:50');
    expect(formatListTime(FRI_2310, SAT_0015)).toBe('Fri 11:10');
    expect(formatListTime(new Date(FRI_0958), new Date(FRI_2310).getTime())).toBe('9:58');
  });

  it('formats audit times like "Nov 6, 11:10 PM"', () => {
    expect(formatAuditTime(FRI_2310)).toBe('Nov 6, 11:10 PM');
    expect(formatAuditTime(FRI_0958)).toBe('Nov 6, 9:58 AM');
  });

  it('formats CSV times in 24 h event time', () => {
    expect(formatCsvTime(FRI_2310)).toBe('2026-11-06 23:10');
    expect(formatCsvTime(SAT_0015)).toBe('2026-11-07 00:15');
    expect(formatCsvTime(null)).toBe('');
  });

  it('handles the DST change (Nov 1 2026) correctly', () => {
    // Oct 31 is EDT (UTC−4); Nov 2 is EST (UTC−5).
    expect(formatClock('2026-10-31T16:00:00Z')).toBe('12:00');
    expect(formatClock('2026-11-02T17:00:00Z')).toBe('12:00');
  });
});

describe('durations', () => {
  it('counts whole minutes, never negative', () => {
    expect(minutesSince('2026-11-06T10:00:00Z', '2026-11-06T10:12:59Z')).toBe(12);
    expect(minutesSince('2026-11-06T10:00:00Z', '2026-11-06T09:59:00Z')).toBe(0);
    expect(minutesSince('garbage', '2026-11-06T09:59:00Z')).toBe(0);
  });

  it('formats like the mockups', () => {
    expect(formatDuration(0)).toBe('now');
    expect(formatDuration(0.9)).toBe('now');
    expect(formatDuration(1)).toBe('1m');
    expect(formatDuration(12)).toBe('12m');
    expect(formatDuration(59)).toBe('59m');
    expect(formatDuration(60)).toBe('1h');
    expect(formatDuration(64)).toBe('1h');
    expect(formatDuration(150)).toBe('2h');
  });

  it('rounds retry minutes up', () => {
    expect(retryMinutes(1)).toBe(1);
    expect(retryMinutes(60)).toBe(1);
    expect(retryMinutes(61)).toBe(2);
    expect(retryMinutes(895)).toBe(15);
  });
});
