// The desk request table's pure model (design/screens/desktop-log.html .tbl / .tr): what each cell shows and
// what a screen reader hears for a row. No React, no I/O: unit-tested in tests/unit/desk/table-model.test.ts.
//
//   #  ·  Friend (name, age / sex muted)  ·  Status  ·  Post  ·  Created  ·  Updated  ·  Logged by
//
// Post and Logged by show only from 1280 px with nothing open (the CSS decides); the row's sentence always
// says them. Times reuse F1's log helpers (lib/format.ts), so the desk and the phone never disagree.
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { ageGender, canonicalTeam, parseStaff, postFilterLabel, teamShort, type TeamValue } from '@/lib/domain';
import { formatAuditTime, formatCaseNumber, formatCreatedTime, formatUpdatedAgo, updatedPhrase, wasUpdated } from '@/lib/format';
import { displayName, outboxDisplay, outboxRowLabel, statusPhrase, updatedSince, whoPhrase } from '@/components/list/list-helpers';

/** The columns, in order. `wide` ones show only from 1280 px with nothing open in the pane. */
export const TABLE_COLUMNS = [
  { key: 'number', label: '#', wide: false, end: false },
  { key: 'friend', label: 'Friend', wide: false, end: false },
  { key: 'status', label: 'Status', wide: false, end: false },
  { key: 'post', label: 'Post', wide: true, end: false },
  { key: 'created', label: 'Created', wide: false, end: true },
  { key: 'updated', label: 'Updated', wide: false, end: true },
  { key: 'by', label: 'Logged by', wide: true, end: false },
] as const;

export type TableColumnKey = (typeof TABLE_COLUMNS)[number]['key'];

/** The mockup's short team names for the Logged by column ("Dana K. · Transpo"). */
export const TEAM_COMPACT: Readonly<Record<TeamValue, string>> = {
  'GC/HX - Special Operations/Med Transpo': 'Transpo',
  'GC/HX - Dispatch': 'Dispatch',
  'GC/HX - Base': 'Base',
  Medical: 'Medical',
};

/** "Dana Kim" → "Dana K.", "Rae" → "Rae", "Dani V." → "Dani V.". A last word with no letter keeps the name. */
export function compactStaffName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return words[0] ?? '';
  const initial = /\p{L}/u.exec(words[words.length - 1] ?? '')?.[0];
  return initial ? `${words[0]} ${initial.toUpperCase()}.` : words.join(' ');
}

/** The team as the Logged by column shows it: a known team's short name, any other team as typed. */
export function compactTeam(team: string): string {
  const canonical = canonicalTeam(team);
  return (TEAM_COMPACT as Readonly<Record<string, string>>)[canonical] ?? canonical;
}

/** The Logged by cell: "Dana K. · Transpo" from "Dana Kim · GC/HX - Special Operations/Med Transpo". */
export function loggedByShort(createdBy: string | null | undefined): string {
  const staff = parseStaff(createdBy);
  const name = compactStaffName(staff.name);
  return staff.team ? `${name} · ${compactTeam(staff.team)}` : name;
}

/** Logged by in full, as a tooltip and a screen reader say it: "Dana Kim, GCHX Med Transpo". */
export function loggedByPhrase(createdBy: string | null | undefined): string {
  const staff = parseStaff(createdBy);
  return staff.team ? `${staff.name}, ${teamShort(staff.team)}` : staff.name;
}

/** The Post cell: the post's full name, an Other location as "Other · Gate 9" (never mistaken for a post). */
export function postCell(row: Pick<RequestSummary, 'reportingLocation' | 'otherLocation'>): string {
  return postFilterLabel(row.reportingLocation, row.otherLocation);
}

export interface RowTimes {
  /** "11:02 PM" / "Thu 11:02 PM" (format.formatCreatedTime). */
  created: string;
  /** "Nov 6, 11:02 PM": the created cell's tooltip. */
  createdTitle: string;
  /** "2m" / "—" (format.formatUpdatedAgo). */
  updated: string;
  /** "updated 2 minutes ago" / "not updated yet" (format.updatedPhrase). */
  updatedSaid: string;
  /** The exact time of the last change, for the updated cell's tooltip, or null when it never changed. */
  updatedTitle: string | null;
}

/** The created / updated cells of a row, as F1's phone log computes them. */
export function rowTimes(row: RequestSummary, now: number, timeZone: string): RowTimes {
  const since = updatedSince(row);
  return {
    created: formatCreatedTime(row.createdAt, now, timeZone),
    createdTitle: formatAuditTime(row.createdAt, timeZone),
    updated: formatUpdatedAgo(row.createdAt, since, now),
    updatedSaid: updatedPhrase(row.createdAt, since, now),
    updatedTitle: since && wasUpdated(row.createdAt, since) ? formatAuditTime(since, timeZone) : null,
  };
}

/**
 * A row's accessible name, one sentence (the visible cells are hidden from screen readers):
 * "LP-1013, T.R., 24 M, Waiting for check, created 11:02 PM, not updated yet, FA 4 – Oasis, logged by Lee
 * Park, GCHX Base". It starts like the phone log's sentence (number, name, status), then says the columns a
 * desk adds.
 */
export function tableRowLabel(row: RequestSummary, times: Pick<RowTimes, 'created' | 'updatedSaid'>): string {
  const by = loggedByPhrase(row.createdBy);
  return [
    formatCaseNumber(row.caseNumber),
    whoPhrase(row),
    statusPhrase(row.status),
    `created ${times.created}`,
    times.updatedSaid,
    postCell(row),
    by ? `logged by ${by}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** A search result's sentence: the row's, then the matched text when the match is not the name or number. */
export function searchRowLabel(row: RequestSummary, times: Pick<RowTimes, 'created' | 'updatedSaid'>, line: string): string {
  return `${tableRowLabel(row, times)}.${line ? ` ${line}` : ''}`;
}

export interface OutboxRowModel {
  /** The LP number once the server assigned one, else '' (nothing in the number column). */
  number: string;
  name: string;
  ageGender: string;
  post: string;
  by: string;
  needsAttention: boolean;
  label: 'Waiting to send' | 'Needs attention';
  /** The phone's sentence ("Kayla, 19 F, 11:02 PM. Waiting to send, FA 3, Not sent."), so specs match both. */
  said: string;
}

/** A request saved on this device and not sent yet, as a table row. */
export function outboxRow(item: OutboxItem, created: string): OutboxRowModel {
  const d = outboxDisplay(item);
  const p = item.payload;
  return {
    number: item.caseNumber ? String(item.caseNumber) : '',
    name: d.name,
    ageGender: d.ageGender,
    post: postFilterLabel(p.reportingLocation, p.otherLocation ?? null),
    by: loggedByShort(item.operator.staff),
    needsAttention: d.needsAttention,
    label: d.label,
    said: outboxRowLabel(d, created),
  };
}

/** The Friend cell's two parts: the name (or "No name") and the muted age / sex ("24 M", "mid-20s F"). */
export function friendCell(row: Pick<RequestSummary, 'name' | 'age' | 'gender'>): { name: string; ageGender: string } {
  return { name: displayName(row.name), ageGender: ageGender(row.age, row.gender) };
}
