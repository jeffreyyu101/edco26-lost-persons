#!/usr/bin/env node
// Writes the production paste for Companion (supabase/migrations/20261108120000_companion.sql), like
// scripts/dashboard-v4-sql.mjs:
//
//   node scripts/companion-sql.mjs [dir]      (default /tmp/companion-build/prod)
//     <dir>/migration.sql   the migration as it is (begin; … commit;)      ← paste this to apply
//     <dir>/dry-run.sql     begin; the same statements; rollback;          ← paste this first: nothing is kept
//
// Reads the repo only; never connects to a database.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'supabase/migrations/20261108120000_companion.sql');

/** The statements between the file's `begin;` and its final `commit;`. */
export function body(sql = readFileSync(FILE, 'utf8')) {
  const start = sql.indexOf('\nbegin;\n');
  const end = sql.lastIndexOf('\ncommit;');
  if (start < 0 || end < start) throw new Error('companion-sql: begin; / commit; not found');
  return sql.slice(start + '\nbegin;\n'.length, end).trim() + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? '/tmp/companion-build/prod';
  mkdirSync(dir, { recursive: true });
  const sql = readFileSync(FILE, 'utf8');
  writeFileSync(join(dir, 'migration.sql'), sql);
  writeFileSync(join(dir, 'dry-run.sql'), `begin;\n${body(sql)}rollback;\n`);
  console.log(`companion-sql: wrote ${dir}/migration.sql and dry-run.sql`);
}
