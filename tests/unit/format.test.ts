import { describe, expect, it } from 'vitest';
import {
  FALLBACK_TIMEZONE,
  NOT_UPDATED,
  agoPhrase,
  eventDate,
  formatAgoShort,
  formatAuditTime,
  formatCaseNumber,
  formatClock,
  formatClockAmPm,
  formatCreatedTime,
  formatDuration,
  formatListTime,
  formatUpdatedAgo,
  isSameEventDay,
  minutesSince,
  parseCaseNumberQuery,
  retryMinutes,
  updatedPhrase,
  wasUpdated,
} from '@/lib/format';

// 2026-11-07T04:10:00Z is Fri Nov 6, 11:10 PM in America/New_York (EST, UTC−5 after Nov 1). (Events) The event's zone
// is passed in, as every screen passes its event's (EventConfig.timezone).
const ET = 'America/New_York';
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
  it("(events) no event's zone is built in: the fallback is UTC; every screen passes its event's", () => {
    expect(FALLBACK_TIMEZONE).toBe('UTC');
  });

  it('uses the event day, not UTC', () => {
    expect(eventDate(FRI_2310, ET)).toBe('2026-11-06');
    expect(isSameEventDay(FRI_2310, FRI_0958, ET)).toBe(true);
    expect(isSameEventDay(FRI_2310, SAT_0015, ET)).toBe(false);
    expect(eventDate(FRI_2310, 'UTC')).toBe('2026-11-07');
  });

  it('shows h:mm for today and a weekday prefix otherwise', () => {
    expect(formatClock(FRI_2310, ET)).toBe('11:10');
    expect(formatListTime(FRI_0958, FRI_2310, ET)).toBe('9:58');
    expect(formatListTime(THU_2350, FRI_2310, ET)).toBe('Thu 11:50');
    expect(formatListTime(FRI_2310, SAT_0015, ET)).toBe('Fri 11:10');
    expect(formatListTime(new Date(FRI_0958), new Date(FRI_2310).getTime(), ET)).toBe('9:58');
  });

  it('formats audit times like "Nov 6, 11:10 PM"', () => {
    expect(formatAuditTime(FRI_2310, ET)).toBe('Nov 6, 11:10 PM');
    expect(formatAuditTime(FRI_0958, ET)).toBe('Nov 6, 9:58 AM');
  });

  it('handles the DST change (Nov 1 2026) correctly', () => {
    // Oct 31 is EDT (UTC−4); Nov 2 is EST (UTC−5).
    expect(formatClock('2026-10-31T16:00:00Z', ET)).toBe('12:00');
    expect(formatClock('2026-11-02T17:00:00Z', ET)).toBe('12:00');
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

// The All requests log (option B): Created with AM/PM in the event timezone, Updated as a compact age.
describe('log times', () => {
  // Midnight and noon in New York (EST, UTC−5).
  const SAT_0000 = '2026-11-07T05:00:00Z';
  const SAT_0005 = '2026-11-07T05:05:00Z';
  const SAT_1200 = '2026-11-07T17:00:00Z';
  const SAT_1259 = '2026-11-07T17:59:00Z';
  const SAT_1300 = '2026-11-07T18:00:00Z';

  it('formats a clock with AM/PM, including 12 AM and 12 PM', () => {
    expect(formatClockAmPm(FRI_2310, ET)).toBe('11:10 PM');
    expect(formatClockAmPm(FRI_0958, ET)).toBe('9:58 AM');
    expect(formatClockAmPm(SAT_0000, ET)).toBe('12:00 AM');
    expect(formatClockAmPm(SAT_0005, ET)).toBe('12:05 AM');
    expect(formatClockAmPm(SAT_1200, ET)).toBe('12:00 PM');
    expect(formatClockAmPm(SAT_1259, ET)).toBe('12:59 PM');
    expect(formatClockAmPm(SAT_1300, ET)).toBe('1:00 PM');
    // In the event timezone, not the machine's or UTC.
    expect(formatClockAmPm(FRI_2310, 'UTC')).toBe('4:10 AM');
    expect(formatClockAmPm('2026-10-31T16:00:00Z', ET)).toBe('12:00 PM'); // EDT before the Nov 1 change
  });

  it('Created: the clock on the same event day, the weekday for an earlier day, the date beyond a week', () => {
    expect(formatCreatedTime(FRI_0958, FRI_2310, ET)).toBe('9:58 AM');
    expect(formatCreatedTime(FRI_2310, FRI_2310, ET)).toBe('11:10 PM');
    expect(formatCreatedTime(THU_2350, FRI_2310, ET)).toBe('Thu 11:50 PM');
    // Across midnight: logged at 11:10 PM Friday, seen at 12:15 AM Saturday.
    expect(formatCreatedTime(FRI_2310, SAT_0015, ET)).toBe('Fri 11:10 PM');
    // Logged at 12:05 AM Saturday, seen the same night: no weekday.
    expect(formatCreatedTime(SAT_0005, SAT_0015, ET)).toBe('12:05 AM');
    // The midnight boundary in the event timezone (Friday 11:10 PM NY is already Saturday in UTC).
    expect(formatCreatedTime(FRI_2310, '2026-11-07T04:59:00Z', ET)).toBe('11:10 PM');
    expect(formatCreatedTime(FRI_2310, SAT_0000, ET)).toBe('Fri 11:10 PM');
    expect(formatCreatedTime('2026-10-30T01:41:00Z', SAT_0015, ET)).toBe('Oct 29 9:41 PM');
    expect(formatCreatedTime(new Date(FRI_0958), new Date(FRI_2310).getTime(), ET)).toBe('9:58 AM');
    // Another event timezone.
    expect(formatCreatedTime(FRI_2310, FRI_2310, 'UTC')).toBe('4:10 AM');
  });

  it('Updated: "—" when unchanged since logged, else now / m / h / d with no "ago"', () => {
    const created = '2026-11-07T04:00:00Z';
    expect(wasUpdated(created, created)).toBe(false);
    expect(wasUpdated(created, null)).toBe(false);
    expect(wasUpdated(created, '2026-11-07T03:59:00Z')).toBe(false);
    expect(wasUpdated(created, '2026-11-07T04:00:00.000001Z')).toBe(false); // same millisecond
    expect(wasUpdated(created, '2026-11-07T04:00:01Z')).toBe(true);
    expect(formatUpdatedAgo(created, created, FRI_2310)).toBe(NOT_UPDATED);
    expect(NOT_UPDATED).toBe('—');
    expect(formatUpdatedAgo(created, '2026-11-07T04:09:40Z', FRI_2310)).toBe('now');
    expect(formatUpdatedAgo(created, '2026-11-07T04:08:00Z', FRI_2310)).toBe('2m');
    expect(formatUpdatedAgo(created, '2026-11-07T04:00:01Z', '2026-11-07T05:30:00Z')).toBe('1h');
    expect(formatUpdatedAgo(created, '2026-11-07T04:00:01Z', '2026-11-10T05:00:00Z')).toBe('3d');
    // A phone clock behind the database clock never shows a negative age.
    expect(formatUpdatedAgo(created, '2026-11-07T04:20:00Z', FRI_2310)).toBe('now');
  });

  it('compact ages and their spoken form', () => {
    expect(formatAgoShort(0)).toBe('now');
    expect(formatAgoShort(Number.NaN)).toBe('now');
    expect(formatAgoShort(59)).toBe('59m');
    expect(formatAgoShort(60)).toBe('1h');
    expect(formatAgoShort(1_439)).toBe('23h');
    expect(formatAgoShort(1_440)).toBe('1d');
    expect(formatAgoShort(4_400)).toBe('3d');
    expect(agoPhrase(0)).toBe('just now');
    expect(agoPhrase(1)).toBe('1 minute ago');
    expect(agoPhrase(2)).toBe('2 minutes ago');
    expect(agoPhrase(61)).toBe('1 hour ago');
    expect(agoPhrase(3 * 1_440)).toBe('3 days ago');
    const created = '2026-11-07T04:00:00Z';
    expect(updatedPhrase(created, created, FRI_2310)).toBe('not updated yet');
    expect(updatedPhrase(created, '2026-11-07T04:08:00Z', FRI_2310)).toBe('updated 2 minutes ago');
  });
});
