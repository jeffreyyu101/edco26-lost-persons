// docs/export.sql (v2.5, A50; F3 adds Query 3) must stay safe to paste into the production SQL editor: comments
// aside, it is exactly three read-only SELECT statements (WITH … SELECT), with no statement or function that writes, locks,
// changes a setting or reads files. The top comment gives Jeffrey the steps. Reads the file only; the
// integration suite (tests/integration/export-sql.test.ts) runs it on the local database.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sql = readFileSync(`${root}docs/export.sql`, 'utf8');

interface Parsed {
  /** Statements with comments removed, string literals as '' and quoted identifiers as "". */
  statements: string[];
  /** Every quoted identifier (the column labels), in order. */
  identifiers: string[];
  /** Every string literal, in order. */
  literals: string[];
  comments: string[];
}

/** A small SQL lexer: -- and nested /* *\/ comments, '…' (with ''), E'…', $tag$…$tag$ and "…" (with ""). */
function parse(text: string): Parsed {
  const out: Parsed = { statements: [], identifiers: [], literals: [], comments: [] };
  let current = '';
  let i = 0;
  const readQuoted = (quote: string, allowBackslash: boolean): string => {
    let value = '';
    i += 1;
    for (;;) {
      if (i >= text.length) throw new Error(`unterminated ${quote} at ${i}`);
      const ch = text[i] as string;
      if (allowBackslash && ch === '\\') {
        value += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === quote && text[i + 1] === quote) {
        value += quote;
        i += 2;
        continue;
      }
      if (ch === quote) {
        i += 1;
        return value;
      }
      value += ch;
      i += 1;
    }
  };
  while (i < text.length) {
    const ch = text[i] as string;
    const rest = text.slice(i);
    if (rest.startsWith('--')) {
      const end = text.indexOf('\n', i);
      out.comments.push(text.slice(i, end === -1 ? text.length : end));
      i = end === -1 ? text.length : end;
      current += ' ';
    } else if (rest.startsWith('/*')) {
      let depth = 0;
      const start = i;
      do {
        if (text.startsWith('/*', i)) {
          depth += 1;
          i += 2;
        } else if (text.startsWith('*/', i)) {
          depth -= 1;
          i += 2;
        } else if (i >= text.length) {
          throw new Error('unterminated block comment');
        } else {
          i += 1;
        }
      } while (depth > 0);
      out.comments.push(text.slice(start, i));
      current += ' ';
    } else if (ch === "'" || ((ch === 'E' || ch === 'e') && text[i + 1] === "'" && !/\w/.test(text[i - 1] ?? ''))) {
      const escaped = ch !== "'";
      if (escaped) i += 1;
      out.literals.push(readQuoted("'", escaped));
      current += "''";
    } else if (ch === '"') {
      out.identifiers.push(readQuoted('"', false));
      current += '""';
    } else if (ch === '$' && /^\$[A-Za-z_]?\w*\$/.test(rest) && !/\w/.test(text[i - 1] ?? '')) {
      const tag = (/^\$[A-Za-z_]?\w*\$/.exec(rest) as RegExpExecArray)[0];
      const end = text.indexOf(tag, i + tag.length);
      if (end === -1) throw new Error(`unterminated ${tag}`);
      out.literals.push(text.slice(i + tag.length, end));
      i = end + tag.length;
      current += "''";
    } else if (ch === ';') {
      out.statements.push(current.trim());
      current = '';
      i += 1;
    } else {
      current += ch;
      i += 1;
    }
  }
  if (current.trim() !== '') out.statements.push(current.trim());
  return out;
}

const parsed = parse(sql);

// Anything that writes, locks, changes a setting, runs dynamic code or reaches outside the database.
const FORBIDDEN = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke', 'copy', 'merge',
  'call', 'do', 'execute', 'prepare', 'set', 'reset', 'begin', 'start', 'commit', 'rollback', 'savepoint',
  'lock', 'vacuum', 'analyze', 'cluster', 'reindex', 'refresh', 'comment', 'security', 'listen', 'notify',
  'into', 'share', 'nextval', 'setval', 'set_config', 'dblink', 'lo_import', 'lo_export', 'pg_read_file',
  'pg_read_binary_file', 'pg_ls_dir', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_sleep',
];

describe('docs/export.sql', () => {
  it('parses as exactly three statements, each a WITH … SELECT', () => {
    expect(parsed.statements).toHaveLength(3);
    for (const statement of parsed.statements) {
      expect(statement).toMatch(/^with\s+settings\s+as\s*\(\s*select\b/i);
      expect(statement).toMatch(/\)\s*select\b[\s\S]+\bfrom\b/i);
    }
  });

  it('holds no statement or function that writes, locks or changes anything', () => {
    for (const statement of parsed.statements) {
      for (const word of FORBIDDEN) {
        expect(new RegExp(`\\b${word}\\b`, 'i').test(statement), `"${word}" in: ${statement.slice(0, 80)}…`).toBe(false);
      }
    }
    // No dollar-quoted bodies, no psql meta-commands.
    expect(sql).not.toMatch(/\$\w*\$/);
    expect(sql).not.toMatch(/^\s*\\/m);
  });

  it('reads only the requests, the audit trail and the messages', () => {
    const [requests, audit, thread] = parsed.statements as [string, string, string];
    expect(requests).toMatch(/\bfrom public\.patients p\b/);
    expect(requests).toMatch(/order by p\.case_number\s*$/);
    expect(audit).toMatch(/\bfrom public\.audit_events e\b/);
    expect(audit).toMatch(/\bjoin public\.patients p on p\.id = e\.patient_id\b/);
    expect(thread).toMatch(/\bfrom public\.lp_messages m\b/);
    expect(thread).toMatch(/\bfrom public\.audit_events e\b/);
    expect(thread).toMatch(/order by p\.case_number nulls last, ev\.at\s*$/);
    const tables = [...parsed.statements.join(' ').matchAll(/\b(?:from|join)\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(new Set(tables)).toEqual(new Set(['public.patients', 'public.audit_events', 'public.lp_messages', 'public.events', 'settings', 'events']));
  });

  it('Query 1 has every field the old CSV had, with New York times', () => {
    for (const label of [
      'Case number', 'Name', 'Age', 'Gender', 'Height/build', 'Hair', 'Identifying features', 'Physical description',
      'Clothing', 'Last seen', 'Notes', 'Reporting location', 'Other location', 'Contact name', 'Contact phone',
      'Contact relationship', 'Contact notes', 'Status', 'Created', 'Updated', 'Found', 'Reunion started', 'Closed',
      'Created by', 'Updated by',
    ]) {
      expect(parsed.identifiers, label).toContain(label);
    }
    expect(parsed.literals.filter((l) => l === 'America/New_York')).toHaveLength(3);
  });

  it('guards free-text age and gender like the other text columns', () => {
    // Literals read as '' and labels as "" after lexing. age::text also works while age is still smallint.
    const [requests] = parsed.statements as [string];
    expect(requests).toMatch(/regexp_replace\(p\.age::text, s\.guard, ''\) as ""/);
    expect(requests).toMatch(/regexp_replace\(p\.gender, s\.guard, ''\) as ""/);
    expect(requests).not.toMatch(/(?<!regexp_replace\()p\.(age|gender)\b(?!::text, s\.guard|, s\.guard)/);
  });

  it('starts with the three steps for the SQL editor', () => {
    const header = parsed.comments.slice(0, 12).join('\n');
    expect(header).toMatch(/1\. Supabase dashboard → SQL Editor/);
    expect(header).toMatch(/2\. .*Run/);
    expect(header).toMatch(/3\. .*Download CSV/);
  });
});
