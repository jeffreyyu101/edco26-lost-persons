// Pure display helpers for the list views (All, Pending, My requests, Search). No React, no I/O:
// everything here is unit-tested in tests/unit/list-helpers.test.ts.
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import type { SearchHit } from '@/lib/client/selectors';
import { STATUS, ageGender, isInMedical, postShort, sameStaff, statusMeta, type StatusTone } from '@/lib/domain';
import { stagePhrase, type StageSource } from '@/lib/stages';
import { formatCaseNumber } from '@/lib/format';

/** Shown where a request has no name (a photo or description alone is a valid request). */
export const NO_NAME = 'No name';

/** Cards that changed this recently get the "fresh" outline (requests.html .fresh). */
export const FRESH_MS = 60_000;

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

const clean = (v: string | null | undefined): string => (v ?? '').trim();

export function displayName(name: string | null | undefined): string {
  return clean(name) || NO_NAME;
}

/**
 * The Radix text colour for a status label: the status tone, except grey statuses (closed / legacy),
 * which inherit the row colour and are dimmed by the row instead (mockup: "Reunited" has no colour).
 */
export function labelColor(tone: StatusTone): Exclude<StatusTone, 'gray'> | undefined {
  return tone === 'gray' ? undefined : tone;
}

export function isClosed(status: string): boolean {
  return statusMeta(status).bucket === 'closed';
}

/**
 * The Pending card's 2-line description (requests.html .qd): what they're wearing first, then the
 * description, features and hair. Empty parts and exact repeats are skipped.
 */
export function cardDescription(row: Pick<RequestSummary, 'clothing' | 'physicalDescription' | 'identifyingFeatures' | 'hair'>): string {
  const parts: string[] = [];
  for (const raw of [row.clothing, row.physicalDescription, row.identifyingFeatures, row.hair]) {
    const v = clean(raw).replace(/\s+/g, ' ');
    if (v && !parts.some((p) => p.toLowerCase() === v.toLowerCase())) parts.push(v);
  }
  return parts.join(' · ');
}

/** When the request entered its current status (Friend coming time, My requests "3m"). */
export function statusSince(row: Pick<RequestSummary, 'status' | 'createdAt' | 'updatedAt' | 'foundAt' | 'reunionStartedAt' | 'closedAt'>): string {
  if (row.status === STATUS.waiting) return row.createdAt;
  if (isInMedical(row.status)) return row.reunionStartedAt ?? row.foundAt ?? row.updatedAt;
  if (isClosed(row.status)) return row.closedAt ?? row.updatedAt;
  return row.updatedAt;
}

/**
 * True when `iso` is within the last FRESH_MS of `now`. A timestamp slightly in the future (phone clock
 * behind the database clock) still counts as fresh; one far in the future does not.
 */
export function isFresh(iso: string | null | undefined, now: number): boolean {
  const t = ms(iso);
  if (!Number.isFinite(t)) return false;
  return t >= now - FRESH_MS && t <= now + FRESH_MS;
}

/**
 * My requests: the outline colour for a card whose status someone else changed in the last minute
 * (requests.html MCard `fresh ${color}`), or null. This phone's own changes are not highlighted.
 */
export function mineFreshTone(
  row: Pick<RequestSummary, 'status' | 'createdAt' | 'updatedAt' | 'updatedBy' | 'foundAt' | 'reunionStartedAt' | 'closedAt'>,
  now: number,
  sessionStaff: string | null,
): StatusTone | null {
  if (row.status === STATUS.waiting) return null;
  if (sameStaff(row.updatedBy, sessionStaff)) return null;
  return isFresh(statusSince(row), now) ? statusMeta(row.status).tone : null;
}

// ---------------------------------------------------------------------------------------------------
// Progress stepper (My requests): Logged → Checked → In medical → Reunited
// ---------------------------------------------------------------------------------------------------

export interface StepperModel {
  steps: string[];
  /** Index of the current step; earlier steps are done. */
  current: number;
  /** pend: an empty ring in the tone (waiting for it) · cur: a filled dot in the tone (it happened). */
  mode: 'pend' | 'cur';
  /** CSS colour of the current step. */
  color: string;
}

const STEPS = ['Logged', 'Checked', statusMeta(STATUS.inMedical).shortLabel, statusMeta(STATUS.reunited).shortLabel];

export function stepperModel(status: string): StepperModel {
  switch (status) {
    case STATUS.waiting:
      return { steps: STEPS, current: 1, mode: 'pend', color: 'var(--blue-9)' };
    case STATUS.notInMedical:
      // Not found in medical is final: the line ends there (DECISIONS: Logged → Checked → Not found in medical).
      // It is closed, so it is grey like the other closed statuses (2026-11-06).
      return { steps: ['Logged', 'Checked', statusMeta(STATUS.notInMedical).shortLabel], current: 2, mode: 'cur', color: 'var(--gray-9)' };
    case STATUS.inMedical:
    case STATUS.legacyBringFriend:
      return { steps: STEPS, current: 2, mode: 'cur', color: 'var(--green-9)' };
    case STATUS.reunited:
      return { steps: STEPS, current: 3, mode: 'cur', color: 'var(--gray-9)' };
    case STATUS.discharged:
      return { steps: ['Logged', 'Checked', statusMeta(STATUS.inMedical).shortLabel, statusMeta(STATUS.discharged).shortLabel], current: 3, mode: 'cur', color: 'var(--gray-9)' };
    case STATUS.cancelled:
      return { steps: ['Logged', 'Cancelled'], current: 1, mode: 'cur', color: 'var(--gray-9)' };
    default:
      // An unknown legacy status: shown verbatim as the last step.
      return { steps: ['Logged', statusMeta(status).label], current: 1, mode: 'cur', color: 'var(--gray-9)' };
  }
}

/** A request saved on this phone that hasn't been logged yet: nothing is done, "Logged" is pending. */
export function queuedStepper(needsAttention: boolean): StepperModel {
  return { steps: STEPS, current: 0, mode: 'pend', color: needsAttention ? 'var(--red-9)' : 'var(--gray-9)' };
}

// ---------------------------------------------------------------------------------------------------
// Outbox items ("Waiting to send" / "Needs attention" rows on top of All and My requests)
// ---------------------------------------------------------------------------------------------------

export interface OutboxDisplay {
  name: string;
  ageGender: string;
  post: string;
  /** "Not sent", or the LP number once the server has assigned one. */
  caseText: string;
  needsAttention: boolean;
  label: 'Waiting to send' | 'Needs attention';
}

export function outboxDisplay(item: Pick<OutboxItem, 'payload' | 'state' | 'caseNumber'>): OutboxDisplay {
  const p = item.payload;
  const needsAttention = item.state === 'needs_attention';
  return {
    name: displayName(p.name ?? null),
    ageGender: ageGender(p.age ?? null, p.gender ?? null),
    post: postShort(p.reportingLocation, p.otherLocation ?? null),
    caseText: item.caseNumber ? formatCaseNumber(item.caseNumber) : 'Not sent',
    needsAttention,
    label: needsAttention ? 'Needs attention' : 'Waiting to send',
  };
}

// ---------------------------------------------------------------------------------------------------
// Search results (states.html Search): highlight + snippet
// ---------------------------------------------------------------------------------------------------

export type Ranges = Array<[number, number]>;

/**
 * A single-line snippet of a long field that starts close to the first match, so the highlight is visible
 * in a truncated line: "…pink hair, glitter on face". Ranges are shifted to match. Short leads are kept.
 */
export function snippet(text: string, ranges: Ranges, lead = 18): { text: string; ranges: Ranges } {
  const first = ranges[0];
  if (!first || first[0] <= lead) return { text, ranges };
  let start = first[0] - lead;
  // Prefer to start at a word: the first character after whitespace inside the window.
  const window = text.slice(start, first[0]);
  const ws = window.search(/\s\S/);
  if (ws >= 0) start += ws + 1;
  const shift = start - 1; // one character for the "…"
  return {
    text: `…${text.slice(start)}`,
    ranges: ranges.filter(([s]) => s >= start).map(([s, e]) => [s - shift, e - shift] as [number, number]),
  };
}

export interface SearchDisplay {
  /** Highlight ranges in the name (name hits). */
  nameRanges: Ranges;
  /** Highlight ranges in formatCaseNumber(caseNumber) (LP number hits). */
  caseRanges: Ranges;
  /** The description line, and its highlight ranges (empty for name / LP hits). */
  line: string;
  lineRanges: Ranges;
}

export function searchDisplay(hit: SearchHit): SearchDisplay {
  if (hit.field === 'name') {
    return { nameRanges: hit.ranges, caseRanges: [], line: cardDescription(hit.row), lineRanges: [] };
  }
  if (hit.field === 'caseNumber') {
    return { nameRanges: [], caseRanges: hit.ranges, line: cardDescription(hit.row), lineRanges: [] };
  }
  const s = snippet(hit.text, hit.ranges);
  return { nameRanges: [], caseRanges: [], line: s.text, lineRanges: s.ranges };
}

/** Splits `text` into plain and highlighted parts for rendering. Overlapping / out-of-range ranges are clamped. */
export function highlightParts(text: string, ranges: Ranges): Array<{ text: string; hit: boolean }> {
  const out: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [rs, re] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const s = Math.max(at, Math.min(rs, text.length));
    const e = Math.max(s, Math.min(re, text.length));
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    if (e > s) out.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

export function resultCount(n: number): string {
  return `${n} ${n === 1 ? 'result' : 'results'}`;
}

// ---------------------------------------------------------------------------------------------------
// Screen-reader sentences (visible text stays terse; labels say everything)
// ---------------------------------------------------------------------------------------------------

export function minutesPhrase(minutes: number): string {
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const h = Math.floor(minutes / 60);
  return `${h} ${h === 1 ? 'hour' : 'hours'}`;
}

/** "Kayla Martinez, 19 F" / "No name". */
export function whoPhrase(row: Pick<RequestSummary, 'name' | 'age' | 'gender'>): string {
  const ag = ageGender(row.age, row.gender);
  return ag ? `${displayName(row.name)}, ${ag}` : displayName(row.name);
}

/** A queued request: "Kayla Martinez, 19 F, 10:58 PM. Waiting to send, FA 3, Not sent." (+ how to fix it). */
export function outboxRowLabel(d: OutboxDisplay, time: string): string {
  const who = d.ageGender ? `${d.name}, ${d.ageGender}` : d.name;
  return `${who}, ${time}. ${d.label}, ${d.post}, ${d.caseText}.${d.needsAttention ? ' Open to fix and resend.' : ''}`;
}

// ---------------------------------------------------------------------------------------------------
// The All requests log (option B, 2026-11-06): one line per request in a shared grid
//   #  ·  Friend  ·  Status  ·  Created  ·  Updated
// ---------------------------------------------------------------------------------------------------

/**
 * When the request last changed after it was logged, or null when it has not (the log's "Updated" shows
 * "—"). The photos its logger attached while logging are part of logging: a new request is saved first and
 * its photos are uploaded right after, each one a write of its own (rowVersion + 1). So a Waiting request
 * whose only writes are its creator's photo uploads (1 ≤ rowVersion ≤ photoCount, last written by the
 * creator) counts as not updated. Any answer, edit or someone else's photo makes it updated. With no write
 * at all (rowVersion 0, including rows older than row versions) the timestamps decide (format.wasUpdated).
 */
export function updatedSince(
  row: Pick<RequestSummary, 'updatedAt' | 'rowVersion' | 'photoCount' | 'status' | 'createdBy' | 'updatedBy'>,
): string | null {
  const onlyOwnPhotos = row.rowVersion >= 1 && row.rowVersion <= row.photoCount && sameStaff(row.updatedBy, row.createdBy);
  return row.status === STATUS.waiting && onlyOwnPhotos ? null : row.updatedAt;
}

/**
 * The status label the log shows on a narrow phone (under 400 px wide), where "Waiting for check" or "Not found
 * in medical" would take the name's room: "Waiting", "Not found" (the glyph says the rest; STATUS_META
 * narrowLabel). Null when the label is already short. The row's sentence always says the full status.
 */
export function narrowStatusLabel(status: string): string | null {
  return statusMeta(status).narrowLabel ?? null;
}

/** The status as a screen reader says it: "Waiting for check", "In medical, friend coming". */
export function statusPhrase(status: string): string {
  return statusMeta(status).label.replace(/\s*·\s*/g, ', ');
}

/**
 * A log row's accessible name, as one sentence:
 * "LP-1013, T.R., Waiting for check, created 11:02 PM, updated 2 minutes ago".
 * `updated` is format.updatedPhrase(): "updated 2 minutes ago" or "not updated yet".
 */
export function logRowLabel(
  row: Pick<RequestSummary, 'caseNumber' | 'name' | 'status' | 'createdAt' | 'recheckAt'> & StageSource,
  created: string,
  updated: string,
  timeZone?: string,
  /** (Pending v9.1) The views' clock: a hold whose recheck time has passed says "Recheck due". */
  now = 0,
): string {
  // (F5) The stage, not just the status: "Not found yet", "Recheck due", "Friend en route".
  return `${formatCaseNumber(row.caseNumber)}, ${displayName(row.name)}, ${stagePhrase(row, timeZone, now)}, created ${created}, ${updated}`;
}

/** A search result in the log grid: the row's sentence, then the matched text when it is not the name. */
export function searchLogLabel(
  row: Pick<RequestSummary, 'caseNumber' | 'name' | 'status' | 'createdAt'> & StageSource,
  created: string,
  updated: string,
  line: string,
  timeZone?: string,
  now = 0,
): string {
  return `${logRowLabel(row, created, updated, timeZone, now)}.${line ? ` ${line}` : ''}`;
}

/** The number column of the log: the LP number without its prefix or padding, "1013", "998". */
export function logNumber(caseNumber: number): string {
  return String(caseNumber);
}

/**
 * Highlight ranges for the bare number in the log's number column, from a search hit's ranges in
 * formatCaseNumber() ("LP-0998" → "998").
 */
export function logNumberRanges(caseNumber: number, caseRanges: Ranges): Ranges {
  const shift = formatCaseNumber(caseNumber).length - logNumber(caseNumber).length;
  const len = logNumber(caseNumber).length;
  return caseRanges
    .map(([s, e]) => [Math.max(0, s - shift), Math.min(len, e - shift)] as [number, number])
    .filter(([s, e]) => e > s);
}

/** The "Archived N" fold's accessible name ("Archived 6 requests"); aria-expanded carries open / folded. */
export function archivedFoldLabel(count: number, label = 'Archived'): string {
  return `${label} ${count} ${count === 1 ? 'request' : 'requests'}`;
}
