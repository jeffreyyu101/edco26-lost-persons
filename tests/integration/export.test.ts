// GET /api/export (spec §6): CSV headers, every field quoted, quotes doubled, event-timezone times and
// the formula-injection guard (= + - @, full-width forms, leading whitespace / control characters, and a
// leading tab / CR / LF), through the real route.
import { describe, expect, it } from 'vitest';
import { formatCaseNumber, formatCsvTime } from '@/lib/format';
import { CSV_COLUMNS } from '@/lib/server/csv';
import { BASE, admin, api, cookieFor, createRequest, newStaff, pii, uniq, withTestServer } from './harness';

/** The export with its raw bytes (Response.text() would strip the BOM). */
async function exportCsv(cookie: string) {
  const res = await fetch(`${BASE}/api/export`, { headers: { cookie } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) };
}

withTestServer();

/** RFC 4180 parser for the export (every field quoted). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') throw new Error(`unquoted field at ${i}`);
    let value = '';
    i += 1;
    for (;;) {
      const ch = text[i];
      if (ch === undefined) throw new Error('unterminated field');
      if (ch === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      value += ch;
      i += 1;
    }
    row.push(value);
    if (text[i] === ',') {
      i += 1;
    } else if (text.startsWith('\r\n', i)) {
      rows.push(row);
      row = [];
      i += 2;
    } else if (i < text.length) {
      throw new Error(`unexpected ${JSON.stringify(text[i])} at ${i}`);
    }
  }
  if (row.length) rows.push(row);
  return rows;
}

describe('GET /api/export', () => {
  it('a CSV attachment named for the event date, no-store, BOM, header row, every request once', async () => {
    const staff = newStaff();
    const r = await createRequest(staff);
    const res = await exportCsv(await cookieFor(staff));
    expect(res.res.status).toBe(200);
    expect(res.res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.res.headers.get('cache-control')).toBe('no-store');
    expect(res.res.headers.get('content-disposition')).toMatch(/^attachment; filename="lost-persons-\d{4}-\d{2}-\d{2}\.csv"$/);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.EVENT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    expect(res.res.headers.get('content-disposition')).toContain(`lost-persons-${today}.csv`);
    expect([...res.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(res.text.slice(1));
    expect(rows[0]).toEqual([...CSV_COLUMNS]);
    const { count } = await admin().from('patients').select('id', { count: 'exact', head: true });
    expect(rows.length - 1).toBe(count);
    expect(rows.every((row) => row.length === CSV_COLUMNS.length)).toBe(true);
    const mine = rows.find((row) => row[0] === formatCaseNumber(r.caseNumber));
    expect(mine).toBeDefined();
    const col = (name: (typeof CSV_COLUMNS)[number]) => (mine as string[])[CSV_COLUMNS.indexOf(name)];
    expect(col('Name')).toBe(r.name);
    expect(col('Status')).toBe('Waiting for check');
    expect(col('Post')).toBe('FA 3 – Kinetic');
    expect(col('Created by')).toBe(r.createdBy);
    expect(col('Created')).toBe(formatCsvTime(r.createdAt, process.env.EVENT_TIMEZONE));
    expect(col('Found')).toBe('');
    // Newest first.
    const created = rows.slice(1).map((row) => row[CSV_COLUMNS.indexOf('Case number')]);
    expect(created[0]).toBe(formatCaseNumber(r.caseNumber));
  });

  it('defuses formula injection in every field and doubles embedded quotes', async () => {
    const staff = newStaff();
    const tag = uniq();
    const r = await createRequest(staff, {
      name: pii(`=HYPERLINK("http://x.invalid") ${tag}`),
      clothing: '+SUM(A1:A9)',
      lastSeen: '-2+3',
      contactName: '@cmd',
      hair: '＝1+1',
      identifyingFeatures: '＋1',
      additionalNotes: '－1',
      contactRelationship: '＠SUM',
      physicalDescription: 'He said "hi" - then left',
      contactNotes: 'Line one\nLine two',
      contactPhone: '+1 407 555 0100',
    });
    // Values the API would trim, written directly: leading whitespace / control / invisible characters.
    const { error } = await admin()
      .from('patients')
      .update({ height_build: '\t=1', other_location: null, last_seen: ' \u0007=2', clothing: '\u200b@x', hair: '\r\n=3', identifying_features: '\n4' })
      .eq('id', r.id);
    expect(error).toBeNull();

    const res = await exportCsv(await cookieFor(staff));
    const rows = parseCsv(res.text.slice(1));
    const row = rows.find((x) => x[0] === formatCaseNumber(r.caseNumber)) as string[];
    const col = (name: (typeof CSV_COLUMNS)[number]) => row[CSV_COLUMNS.indexOf(name)];
    expect(col('Name')).toBe(`'=HYPERLINK("http://x.invalid") ${tag}`);
    expect(col('Clothing')).toBe("'\u200b@x");
    expect(col('Last seen')).toBe("' \u0007=2");
    expect(col('Contact name')).toBe("'@cmd");
    expect(col('Hair')).toBe("'\r\n=3");
    expect(col('Identifying features')).toBe("'\n4");
    expect(col('Height/build')).toBe("'\t=1");
    expect(col('Notes')).toBe("'－1");
    expect(col('Relationship')).toBe("'＠SUM");
    expect(col('Phone')).toBe("'+1 407 555 0100");
    expect(col('Physical description')).toBe('He said "hi" - then left');
    expect(col('Contact notes')).toBe('Line one\nLine two');
    // Raw text: the quote inside the name is doubled.
    expect(res.text).toContain(`"'=HYPERLINK(""http://x.invalid"") ${tag}"`);
  });

  it('requires a session', async () => {
    const res = await api('/api/export');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
