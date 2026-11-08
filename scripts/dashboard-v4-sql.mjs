#!/usr/bin/env node
// Writes the production paste for Dashboard v4 (supabase/migrations/20261108000000_dashboard_v4.sql; HANDOFF.md "Dashboard v4
// in production"):
//
//   node scripts/dashboard-v4-sql.mjs [dir]      (default /tmp/dashboard-v4)
//     <dir>/migration.sql   the migration as it is (begin; … commit;)      ← paste this to apply
//     <dir>/dry-run.sql     begin; the same statements; rollback;          ← paste this first: nothing is kept
//     <dir>/probe.sql       begin; the function; one read-only lp_stats('tonight') reduced to counts and its
//                           duration; rollback;                            ← optional: what tonight would show
//
// Reads the repo only; never connects to a database.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'supabase/migrations/20261108000000_dashboard_v4.sql');

/** The statements between the file's `begin;` and its final `commit;`. */
export function body(sql = readFileSync(FILE, 'utf8')) {
  const start = sql.indexOf('\nbegin;\n');
  const end = sql.lastIndexOf('\ncommit;');
  if (start < 0 || end < start) throw new Error('dashboard-v4-sql: begin; / commit; not found');
  return sql.slice(start + '\nbegin;\n'.length, end).trim() + '\n';
}

/** Counts and timing only: no case number, id or time of any request leaves the database. */
export const PROBE = `create function pg_temp.lp_v4_ms(p text) returns numeric language plpgsql as $ms$
declare t0 timestamptz := clock_timestamp(); s jsonb;
begin s := public.lp_stats(p); return round((extract(epoch from clock_timestamp() - t0) * 1000)::numeric, 1); end
$ms$;
select pg_catalog.jsonb_build_object(
  'tonightMs', pg_temp.lp_v4_ms('tonight'), 'eventMs', pg_temp.lp_v4_ms('event'), 'oneHourMs', pg_temp.lp_v4_ms('1h'),
  'live', s -> 'live',
  'attentionTotal', s #> '{attention,total}',
  'calls', s #> '{calls,total}', 'prevCalls', s #> '{calls,prevTotal}', 'buckets', jsonb_array_length(s #> '{calls,buckets}'),
  'heatCols', jsonb_array_length(s #> '{heat,cols}'),
  'speedN', (select jsonb_object_agg(e ->> 'key', e -> 'n') from jsonb_array_elements(s -> 'speed') e),
  'recapReunited', s #> '{recap,reunited}', 'recapNotLocated', s #> '{recap,notLocated}',
  'teamOn', (select sum((e ->> 'on')::int) from jsonb_array_elements(s -> 'team') e)
) as probe
from (select public.lp_stats('tonight') as s) z;
`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? '/tmp/dashboard-v4';
  mkdirSync(dir, { recursive: true });
  const sql = readFileSync(FILE, 'utf8');
  const b = body(sql);
  writeFileSync(join(dir, 'migration.sql'), sql);
  writeFileSync(join(dir, 'dry-run.sql'), `begin;\n${b}rollback;\n`);
  writeFileSync(join(dir, 'probe.sql'), `begin;\n${b}${PROBE}rollback;\n`);
  console.log(`dashboard-v4-sql: wrote ${dir}/migration.sql, dry-run.sql and probe.sql`);
}
