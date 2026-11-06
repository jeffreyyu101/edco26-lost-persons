// CSV export (spec §6 GET /api/export). Pure; server only.
//
// Every field is quoted, embedded quotes are doubled, and spreadsheet formula injection is defused by
// prefixing "'" when the value — after any leading whitespace or control characters — starts with
// = + - @ (or their full-width forms U+FF1D U+FF0B U+FF0D U+FF20), or when it starts with a tab, CR or LF.
import 'server-only';
import type { RequestSummary } from '../api-types';
import { postFull, statusMeta } from '../domain';
import { eventDate, formatCaseNumber, formatCsvTime } from '../format';

// Whitespace (the JavaScript \s set), C0/C1 controls, and invisible format characters (soft hyphen,
// Arabic letter mark, Mongolian vowel separator, zero-width and bidi marks, word joiners, BOM) that a
// spreadsheet may skip before reading a leading "=".
const LEADING_IGNORABLE =
  /^[\s\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]+/;
// = + - @ and the full-width forms.
const FORMULA_START = /^[=+\-@\uff1d\uff0b\uff0d\uff20]/;
const RAW_DANGEROUS_START = /^[\t\r\n]/;

/** True when a spreadsheet could read the value as a formula. */
export function needsFormulaGuard(value: string): boolean {
  if (RAW_DANGEROUS_START.test(value)) return true;
  return FORMULA_START.test(value.replace(LEADING_IGNORABLE, ''));
}

/** One quoted CSV field. null / undefined → "". */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (needsFormulaGuard(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const CSV_COLUMNS = [
  'Case number',
  'Name',
  'Age',
  'Gender',
  'Status',
  'Post',
  'Clothing',
  'Last seen',
  'Hair',
  'Height/build',
  'Identifying features',
  'Physical description',
  'Notes',
  'Contact name',
  'Phone',
  'Relationship',
  'Contact notes',
  'Created by',
  'Created',
  'Updated',
  'Found',
  'Closed',
] as const;

function csvRow(r: RequestSummary, timeZone: string): Array<string | number | null> {
  return [
    formatCaseNumber(r.caseNumber),
    r.name,
    r.age,
    r.gender,
    statusMeta(r.status).label,
    postFull(r.reportingLocation, r.otherLocation),
    r.clothing,
    r.lastSeen,
    r.hair,
    r.heightBuild,
    r.identifyingFeatures,
    r.physicalDescription,
    r.additionalNotes,
    r.contactName,
    r.contactPhone,
    r.contactRelationship,
    r.contactNotes,
    r.createdBy,
    formatCsvTime(r.createdAt, timeZone),
    formatCsvTime(r.updatedAt, timeZone),
    formatCsvTime(r.foundAt, timeZone),
    formatCsvTime(r.closedAt, timeZone),
  ];
}

const BOM = '\ufeff';

/**
 * The whole file: a UTF-8 BOM (so Excel reads the en dashes and accents correctly), the header row, then
 * one row per request, newest first. CRLF line endings (RFC 4180).
 */
export function buildCsv(rows: readonly RequestSummary[], timeZone: string): string {
  const sorted = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.caseNumber - a.caseNumber);
  const lines = [CSV_COLUMNS.map(csvCell).join(',')];
  for (const r of sorted) lines.push(csvRow(r, timeZone).map(csvCell).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** lost-persons-YYYY-MM-DD.csv, dated in the event timezone. */
export function csvFilename(now: Date, timeZone: string): string {
  return `lost-persons-${eventDate(now, timeZone)}.csv`;
}
