// docs/export.sql (v2.5, A50; F3 Query 3): Jeffrey's end-of-event export from the Supabase SQL editor, which
// replaced the app's CSV route. Every query runs on the local database inside a READ ONLY transaction (so the file can't
// write), return every request once by case number with every field the old CSV had, times in New York, and
// the full audit trail joined to the LP number. The spreadsheet formula guard in the file is checked with
// every injection prefix the old CSV export was tested with.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATUS, STATUS_META } from '@/lib/domain';
import { ROOT, TEST_EVENT_ID, TEST_EVENT_SLUG } from '../../scripts/test-env.mjs';
import { api, cookieFor, createBody, dbUrl, newStaff, pii, psql, staffOf, uniq, withTestServer } from './harness';

withTestServer();

// (Events) The file exports one event (EDC's by default): here the local test event, whose rows the tests create.
const SQL = readFileSync(join(ROOT, 'docs', 'export.sql'), 'utf8').replaceAll("ev.slug = 'edco26'", `ev.slug = '${TEST_EVENT_SLUG}'`);
const [QUERY_1, REST] = SQL.split(/^-- Query 2: audit trail$/m) as [string, string];
const [QUERY_2, QUERY_3] = REST.split(/^-- Query 3: messages and en route$/m) as [string, string];

const REQUEST_COLUMNS = [
  'Case number', 'Name', 'Age', 'Gender', 'Height/build', 'Hair', 'Identifying features', 'Physical description',
  'Clothing', 'Last seen', 'Notes', 'Reporting location', 'Other location', 'Contact name', 'Contact phone',
  'Contact relationship', 'Contact notes', 'Status', 'Status (database)', 'Created', 'Updated', 'Found',
  'Reunion started', 'Closed', 'Created by', 'Updated by',
];
const AUDIT_COLUMNS = ['Case number', 'When', 'Staff', 'Action', 'From status', 'To status', 'Kind', 'Notes', 'Previous value', 'New value'];
const THREAD_COLUMNS = ['Case number', 'When', 'Staff', 'Team', 'Type', 'Text or state', 'ETA', 'Unsent', 'Unsent at'];

/** RFC 4180 records from psql --csv (quoted fields may hold commas, quotes and line breaks). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) rows.push([...row, field]);
  return rows;
}

/** Runs one query of the file in a READ ONLY session (any write would fail) and returns header + rows. */
function runReadOnly(query: string): { header: string[]; rows: string[][] } {
  const out = execFileSync('psql', [dbUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '--csv', '-c', query], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on' },
  });
  const [header, ...rows] = parseCsv(out);
  return { header: header ?? [], rows };
}

/** "2026-11-06 23:10:04" in America/New_York (to_char truncates seconds, as Intl does). */
function newYork(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

const lp = (n: number) => `LP-${String(n).padStart(4, '0')}`;

describe('docs/export.sql', () => {
  it('has exactly the three queries, each read-only in a READ ONLY session', () => {
    expect(QUERY_1).toMatch(/-- Query 1: requests/);
    expect(QUERY_2).toMatch(/from public\.audit_events e/);
    expect(QUERY_3).toMatch(/from public\.lp_messages m/);
    expect(runReadOnly(QUERY_1).header).toEqual(REQUEST_COLUMNS);
    expect(runReadOnly(QUERY_2).header).toEqual(AUDIT_COLUMNS);
    expect(runReadOnly(QUERY_3).header).toEqual(THREAD_COLUMNS);
  });

  it('Query 3: every message (unsent ones marked) and en route event, by case number and time', async () => {
    const foh = newStaff();
    const medical = newStaff('Medical');
    const fohCookie = await cookieFor(foh);
    const medCookie = await cookieFor(medical);
    const created = await api('/api/requests', { json: createBody({ name: pii(`TEST-core-${uniq()}`) }), cookie: fohCookie });
    expect(created.status).toBe(201);
    const r = created.body.request;
    const ask = await api(`/api/requests/${r.id}/messages`, { json: { clientMutationId: crypto.randomUUID(), body: '=SUM(A1) tattoos?' }, cookie: medCookie });
    expect(ask.status).toBe(201);
    const oops = await api(`/api/requests/${r.id}/messages`, { json: { clientMutationId: crypto.randomUUID(), body: 'Wrong one' }, cookie: fohCookie });
    expect(oops.status).toBe(201);
    expect((await api(`/api/requests/${r.id}/messages/${oops.body.message.id}/unsend`, { json: {}, cookie: fohCookie })).status).toBe(200);
    const answered = await api(`/api/requests/${r.id}/status`, {
      json: { status: STATUS.inMedical, expectedVersion: r.rowVersion, kind: 'answer' },
      cookie: medCookie,
    });
    expect(answered.status).toBe(200);
    expect((await api(`/api/requests/${r.id}/enroute`, { json: { action: 'set', etaMinutes: 5 }, cookie: fohCookie })).status).toBe(200);
    expect((await api(`/api/requests/${r.id}/enroute`, { json: { action: 'arrive' }, cookie: fohCookie })).status).toBe(200);

    const { header, rows } = runReadOnly(QUERY_3);
    expect(rows.every((row) => row.length === THREAD_COLUMNS.length)).toBe(true);
    const col = (row: string[], name: string) => row[header.indexOf(name)];
    const mine = rows.filter((row) => row[0] === lp(r.caseNumber));
    expect(mine.map((row) => [col(row, 'Type'), col(row, 'Text or state'), col(row, 'Unsent')])).toEqual([
      ['Message', "'=SUM(A1) tattoos?", 'no'],
      ['Message', 'Wrong one', 'yes'],
      ['En route', 'enroute', ''],
      ['En route', 'arrived', ''],
    ]);
    expect(col(mine[0] as string[], 'Staff')).toBe(staffOf(medical));
    expect(col(mine[0] as string[], 'Team')).toBe('Medical');
    expect(col(mine[1] as string[], 'Unsent at')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(col(mine[2] as string[], 'ETA')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(mine.map((row) => col(row, 'When'))).toEqual([...mine.map((row) => col(row, 'When'))].sort());
    const nums = rows.map((row) => row[0] as string).filter((n) => n !== '').map((n) => Number(n.slice(3)));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });

  it('Query 1: every request once by case number, every field, New York times, guarded formula text', async () => {
    const staff = newStaff();
    const medical = newStaff('Medical');
    const tag = uniq();
    const body = createBody({
      name: pii(`=TEST-core-${tag}`),
      clothing: pii(`+TEST-core cap ${tag}`),
      hair: pii(`TEST-core hair "curly", ${tag}`),
      lastSeen: pii(`TEST-core stage\nnear the gate ${tag}`),
      contactRelationship: 'Friend',
    });
    const created = await api('/api/requests', { json: body, cookie: await cookieFor(staff) });
    expect(created.status).toBe(201);
    const answered = await api(`/api/requests/${created.body.request.id}/status`, {
      json: { status: STATUS.inMedical, expectedVersion: created.body.request.rowVersion, kind: 'answer' },
      cookie: await cookieFor(medical),
    });
    expect(answered.status).toBe(200);
    const r = answered.body.request;

    const before = Number(psql(`select count(*) from public.patients where event_id = '${TEST_EVENT_ID}'`));
    const { header, rows } = runReadOnly(QUERY_1);
    const after = Number(psql(`select count(*) from public.patients where event_id = '${TEST_EVENT_ID}'`));
    expect(rows.length).toBeGreaterThanOrEqual(before);
    expect(rows.length).toBeLessThanOrEqual(after);
    expect(rows.every((row) => row.length === REQUEST_COLUMNS.length)).toBe(true);

    // Ordered by case number, each once, formatted LP-####.
    const numbers = rows.map((row) => row[0] as string);
    expect(numbers.every((n) => /^LP-\d{4,}$/.test(n))).toBe(true);
    const asInts = numbers.map((n) => Number(n.slice(3)));
    expect(asInts).toEqual([...asInts].sort((a, b) => a - b));
    expect(new Set(asInts).size).toBe(asInts.length);

    const mine = rows.filter((row) => row[0] === lp(r.caseNumber));
    expect(mine).toHaveLength(1);
    const col = (name: string) => (mine[0] as string[])[header.indexOf(name)];
    expect(col('Name')).toBe(`'=TEST-core-${tag}`);
    expect(col('Clothing')).toBe(`'+TEST-core cap ${tag}`);
    expect(col('Hair')).toBe(`TEST-core hair "curly", ${tag}`);
    expect(col('Last seen')).toBe(`TEST-core stage\nnear the gate ${tag}`);
    expect(col('Age')).toBe('22');
    expect(col('Gender')).toBe('Female');
    expect(col('Reporting location')).toBe('FA 3 – Kinetic');
    expect(col('Contact phone')).toBe('(407) 555-0100');
    expect(col('Contact relationship')).toBe('Friend');
    expect(col('Status')).toBe(STATUS_META[STATUS.inMedical].label);
    expect(col('Status (database)')).toBe(STATUS.inMedical);
    expect(col('Created')).toBe(newYork(r.createdAt));
    expect(col('Updated')).toBe(newYork(r.updatedAt));
    expect(col('Found')).toBe(newYork(r.foundAt));
    expect(col('Reunion started')).toBe(newYork(r.reunionStartedAt));
    expect(col('Closed')).toBe('');
    expect(col('Created by')).toBe(staffOf(staff));
    expect(col('Updated by')).toBe(staffOf(medical));
  });

  it('Query 1: free-text age and gender are guarded like the other text columns', async () => {
    const staff = newStaff();
    const created = await api('/api/requests', {
      json: createBody({ name: pii(`TEST-core-${uniq()}`), age: '=1+1', gender: '-TEST gender' }),
      cookie: await cookieFor(staff),
    });
    expect(created.status).toBe(201);
    const plain = await api('/api/requests', {
      json: createBody({ name: pii(`TEST-core-${uniq()}`), age: 'mid-20s', gender: 'Non-binary' }),
      cookie: await cookieFor(staff),
    });
    expect(plain.status).toBe(201);

    const { header, rows } = runReadOnly(QUERY_1);
    const one = (n: number) => rows.find((row) => row[0] === lp(n)) as string[];
    const col = (row: string[], name: string) => row[header.indexOf(name)];
    expect(col(one(created.body.request.caseNumber), 'Age')).toBe("'=1+1");
    expect(col(one(created.body.request.caseNumber), 'Gender')).toBe("'-TEST gender");
    expect(col(one(plain.body.request.caseNumber), 'Age')).toBe('mid-20s');
    expect(col(one(plain.body.request.caseNumber), 'Gender')).toBe('Non-binary');
  });

  it('Query 2: the audit trail, one row per event, joined to the LP number, oldest first per request', async () => {
    const staff = newStaff();
    const created = await api('/api/requests', { json: createBody({ name: pii(`TEST-core-${uniq()}`) }), cookie: await cookieFor(staff) });
    expect(created.status).toBe(201);
    const r = created.body.request;
    const medical = await cookieFor(newStaff('Medical'));
    const answered = await api(`/api/requests/${r.id}/status`, {
      json: { status: STATUS.notInMedical, expectedVersion: r.rowVersion, kind: 'answer' },
      cookie: medical,
    });
    expect(answered.status).toBe(200);
    // (F5) The first Not found holds the request (still Waiting for check); the second is final.
    const final = await api(`/api/requests/${r.id}/status`, {
      json: { status: STATUS.notInMedical, expectedVersion: answered.body.request.rowVersion, kind: 'answer' },
      cookie: medical,
    });
    expect(final.body.request.status).toBe(STATUS.notInMedical);

    const { header, rows } = runReadOnly(QUERY_2);
    expect(rows.every((row) => row.length === AUDIT_COLUMNS.length)).toBe(true);
    const mine = rows.filter((row) => row[0] === lp(r.caseNumber));
    expect(mine).toHaveLength(Number(psql(`select count(*) from public.audit_events where patient_id = '${r.id}'`)));
    const col = (row: string[], name: string) => row[header.indexOf(name)];
    expect(mine.map((row) => col(row, 'Action'))).toEqual(['patient_created', 'status_changed', 'status_changed']);
    expect(mine.map((row) => col(row, 'When'))).toEqual([...mine.map((row) => col(row, 'When'))].sort());
    // The hold: Waiting → Waiting, kind answer, and its raw value says held, not found, and when to recheck.
    expect(col(mine[1] as string[], 'From status')).toBe(STATUS.waiting);
    expect(col(mine[1] as string[], 'To status')).toBe(STATUS.waiting);
    expect(col(mine[1] as string[], 'Kind')).toBe('answer');
    expect(JSON.parse(col(mine[1] as string[], 'New value') as string)).toMatchObject({ held: true, answer: 'not_found', not_found_checks: 1 });
    expect(col(mine[2] as string[], 'From status')).toBe(STATUS.waiting);
    expect(col(mine[2] as string[], 'To status')).toBe(STATUS.notInMedical);
    expect(col(mine[2] as string[], 'Kind')).toBe('answer');
    expect(col(mine[0] as string[], 'Staff')).toBe(staffOf(staff));
    expect(JSON.parse(col(mine[0] as string[], 'New value') as string)).toMatchObject({ reporting_location: 'FA 3 – Kinetic' });

    // Grouped by case number (events of requests that no longer exist would sort last).
    const nums = rows.map((row) => row[0] as string).filter((n) => n !== '').map((n) => Number(n.slice(3)));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });

  it('every status gets the label the app shows', () => {
    for (const [value, meta] of Object.entries(STATUS_META)) {
      expect(SQL, value).toContain(`when '${value}' then '${meta.label}'`);
    }
  });

  // The cases the removed CSV export was tested with (lib/server/csv.ts, spec §6 GET /api/export).
  it.each([
    ['=1+1', true], ['+1', true], ['-1', true], ['@SUM(A1)', true],
    ['＝1', true], ['＋1', true], ['－1', true], ['＠x', true],
    [' =1', true], [' 　=1', true], ['\u0007=1', true], ['​@x', true], ['﻿=1', true],
    ['\t=1', true], ['\tplain', true], ['\rplain', true], ['\nplain', true],
    ['plain', false], ['a=b', false], ['Blue - red', false], ['', false], ['(407) 555-0100', false], ['  plain', false],
  ])('formula guard: %j → guarded %s', (value, guarded) => {
    const guard = /'(\^\(\?=[^']+)'::text as guard/.exec(SQL)?.[1];
    expect(guard).toBeTruthy();
    const hex = Buffer.from(value, 'utf8').toString('hex');
    const out = psql(`select encode(convert_to(regexp_replace(convert_from('\\x${hex}'::bytea, 'UTF8'), '${guard}', ''''), 'UTF8'), 'hex')`);
    expect(Buffer.from(out, 'hex').toString('utf8')).toBe(guarded ? `'${value}` : value);
  });
});
