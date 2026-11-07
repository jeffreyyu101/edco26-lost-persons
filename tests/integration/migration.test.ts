// The rework migration (spec §5, A9, A30, A35, A36): applied twice on the migrated app database and on an
// upgrade fixture built from Jeffrey's original schema (legacy column, legacy rows, legacy audit formats,
// old CHECKs), with smoke checks. Wraps scripts/verify-migration.sh (LOCAL ONLY; it has its own host
// guard). Afterwards PostgREST must have reloaded its schema before other tests run.
// Then the free-text age (2026-11-06): smallint → text on a scratch copy of production as it is today
// (rework already applied once), pasted twice. And patients.medical_location (Pending v8, 2026-11-06
// afternoon) on a scratch copy built with the rework file as the F1 release shipped it (commit 7291a7b).
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT } from '../../scripts/test-env.mjs';
import { admin, dbUrl, psql } from './harness';

const run = promisify(execFile);

async function waitForSchema(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const { error } = await admin().rpc('lp_stats');
    if (!error) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('PostgREST did not serve lp_stats again within 20 s');
}

describe('20261106000000_rework.sql', () => {
  it('applies twice on the app database and on the upgrade fixture (scripts/verify-migration.sh)', async () => {
    // The stack under test (SUPABASE_DB_URL from .env.test, else the default stack), never another one.
    const { stdout } = await run('bash', ['scripts/verify-migration.sh'], {
      cwd: ROOT,
      env: { ...process.env, SUPABASE_DB_URL: dbUrl() },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    });
    expect(stdout).toContain(`1. App database (${dbUrl()})`);
    expect(stdout).toContain('re-apply #1: ok');
    expect(stdout).toContain('re-apply #2: ok');
    expect(stdout).toContain('apply #1: ok');
    expect(stdout).toContain('apply #2: ok');
    expect(stdout).toContain('lp_stats byPost adds up to open: ok');
    expect(stdout).toContain('verify-migration: all good');
    await waitForSchema();
  }, 150_000);

  // Review fix (2026-11-06): the script read only `supabase status` (the default stack), so on an isolated
  // stack it re-applied the file to, and built its fixture on, someone else's database.
  it('verify-migration.sh takes SUPABASE_DB_URL, behind its local-host guard', () => {
    const remote = spawnSync('bash', ['scripts/verify-migration.sh'], {
      cwd: ROOT,
      env: { ...process.env, SUPABASE_DB_URL: 'postgresql://postgres:x@db.example.com:5432/postgres' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(remote.status).not.toBe(0);
    expect(remote.stderr).toContain("refusing to run: DB host is 'db.example.com'.");
    expect(remote.stdout).not.toContain('App database');
  });

  it('the scratch fixture database is dropped afterwards', () => {
    expect(psql("select count(*) from pg_database where datname = 'lp_upgrade_fixture'")).toBe('0');
  });

  it('the app database has the rework objects', () => {
    expect(psql("select count(*) from information_schema.columns where table_name = 'patients' and column_name in ('row_version', 'last_seen')")).toBe('2');
    // Where medical has the patient (Pending v8): nullable text, no default.
    expect(psql("select data_type || '/' || is_nullable || '/' || coalesce(column_default, 'none') from information_schema.columns where table_schema = 'public' and table_name = 'patients' and column_name = 'medical_location'")).toBe('text/YES/none');
    expect(psql("select count(*) from information_schema.columns where table_name = 'patient_photos' and column_name = 'thumb_path'")).toBe('1');
    expect(psql("select tgname from pg_trigger where tgrelid = 'public.patients'::regclass and tgname = 'lp_patients_touch'")).toBe('lp_patients_touch');
    // Mutating RPCs carry the function-level timeouts (A7).
    const cfg = psql("select proconfig::text from pg_proc where proname = 'lp_set_status'");
    expect(cfg).toContain('statement_timeout=4s');
    expect(cfg).toContain('lock_timeout=2s');
    // Age is free text (Jeffrey, 2026-11-06): text, with no CHECK left on it.
    expect(psql("select data_type from information_schema.columns where table_schema = 'public' and table_name = 'patients' and column_name = 'age'")).toBe('text');
    expect(psql(AGE_CHECKS)).toBe('0');
  });
});

const AGE_CHECKS = `select count(*) from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attname = 'age'
  where c.conrelid = 'public.patients'::regclass and c.contype = 'c' and a.attnum = any (c.conkey)`;

/**
 * Production today: the rework file already applied once (every lp_* function installed) and age still the
 * baseline smallint with its 0–120 CHECK. Built in a scratch database from the local chain, then age is
 * turned back into smallint with the CHECK and legacy rows are added. The edited file must convert it,
 * keep every value, and stay a no-op when pasted again.
 */
describe('20261106000000_rework.sql: age smallint → text on a database that already has the rework', () => {
  const FIXTURE = 'lp_age_fixture';
  const fixtureUrl = () => `${dbUrl().replace(/\/[^/]*$/, '')}/${FIXTURE}`;
  const sqlIn = (sql: string) =>
    execFileSync('psql', [fixtureUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const applyFile = (file: string) =>
    execFileSync('psql', [fixtureUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-f', join(ROOT, 'supabase/migrations', file)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  /** Applies the file and returns its NOTICE lines (psql prints them on stderr). */
  const applyRework = () => {
    const r = spawnSync('psql', [fixtureUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-f', join(ROOT, 'supabase/migrations/20261106000000_rework.sql')], {
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stderr.split('\n').filter((l) => l.includes('NOTICE:  patients.age'));
  };

  afterAll(() => {
    psql(`drop database if exists ${FIXTURE}`);
  });

  it('converts once, keeps every value, drops the CHECK, and a second paste changes nothing', () => {
    psql(`drop database if exists ${FIXTURE}`);
    psql(`create database ${FIXTURE}`);
    for (const file of readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()) applyFile(file);
    sqlIn(`alter table public.patients alter column age type smallint using age::smallint;
           alter table public.patients add constraint patients_age_check check (age is null or (age between 0 and 120));
           insert into public.patients (client_mutation_id, first_name, last_name, age, gender, reporting_location, status, created_by, updated_by)
           values ('00000000-0000-4000-8000-0000000000e1', 'TEST-server-1', '', 24, 'Male', 'FA 3 – Kinetic', 'Added', 'T · Medical', 'T · Medical'),
                  ('00000000-0000-4000-8000-0000000000e2', 'TEST-server-2', '', 0, 'Female', 'Base', 'Added', 'T · Medical', 'T · Medical'),
                  ('00000000-0000-4000-8000-0000000000e3', 'TEST-server-3', '', null, null, 'Command', 'Added', 'T · Medical', 'T · Medical')`);
    expect(sqlIn("select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.patients'::regclass and attname = 'age'")).toBe('smallint');
    expect(Number(sqlIn("select count(*) from pg_proc where proname like 'lp\\_%'"))).toBeGreaterThanOrEqual(14);

    expect(applyRework()).toEqual([expect.stringContaining('patients.age: smallint → text, every value kept. CHECKs dropped: patients_age_check')]);
    expect(applyRework()).toEqual([expect.stringContaining('patients.age: already text, unchanged.')]);

    expect(sqlIn("select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.patients'::regclass and attname = 'age'")).toBe('text');
    expect(sqlIn(AGE_CHECKS)).toBe('0');
    // lp_sync (what the API reads) returns the old numbers as text.
    expect(sqlIn(`set role service_role;
      select string_agg((r ->> 'first_name') || '=' || coalesce(r ->> 'age', 'null') || ':' || jsonb_typeof(r -> 'age'), ' ' order by r ->> 'first_name')
      from jsonb_array_elements(lp_sync(null) -> 'rows') r`)).toBe('TEST-server-1=24:string TEST-server-2=0:string TEST-server-3=null:null');
    // The recreated functions take free text, keep execute for service_role only, and still refuse over-length text.
    expect(sqlIn(`set role service_role;
      select lp_update_fields(id, '{"age": "mid-20s", "gender": "Non-binary"}', row_version, 'T · Medical') -> 'row' ->> 'age'
      from patients where first_name = 'TEST-server-1'`)).toBe('mid-20s');
    expect(sqlIn(`select string_agg(distinct has_function_privilege('service_role', p.oid, 'execute')::text || '/' ||
                    has_function_privilege('anon', p.oid, 'execute')::text || '/' || has_function_privilege('authenticated', p.oid, 'execute')::text, ',')
                  from pg_proc p where p.proname in ('lp_clean_fields', 'lp_create_request', 'lp_update_fields', 'lp_row', 'lp_sync', 'lp_detail', 'lp_stats')`)).toBe('true/false/false');
    expect(() => sqlIn(`set role service_role;
      select lp_update_fields(id, json_build_object('age', repeat('x', 41))::jsonb, row_version, 'T · Medical') from patients where first_name = 'TEST-server-2'`)).toThrow(/field_too_long/);
  }, 120_000);
});

/**
 * Production before Pending v8: the rework file as the F1 release shipped it (commit 7291a7b: no
 * medical_location anywhere) applied on the baseline, with rows written through those functions. The new file,
 * pasted twice, must add the column once, keep the values set in between, and leave every call the build that
 * is live now makes working exactly as before (it never sends the field; its server maps lp_row through an
 * allowlist, so the extra key is ignored).
 */
describe('20261106000000_rework.sql: medical_location on production as it is before Pending v8', () => {
  const FIXTURE = 'lp_location_fixture';
  const RELEASED = '7291a7b';
  const fixtureUrl = () => `${dbUrl().replace(/\/[^/]*$/, '')}/${FIXTURE}`;
  const sqlIn = (sql: string) =>
    execFileSync('psql', [fixtureUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const applyPath = (path: string) => {
    const r = spawnSync('psql', [fixtureUrl(), '-v', 'ON_ERROR_STOP=1', '-q', '-f', path], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  };
  const REWORK = 'supabase/migrations/20261106000000_rework.sql';
  const column = () =>
    sqlIn("select coalesce(string_agg(data_type || '/' || is_nullable, ','), 'missing') from information_schema.columns where table_schema = 'public' and table_name = 'patients' and column_name = 'medical_location'");
  let scratch: string | null = null;

  afterAll(() => {
    psql(`drop database if exists ${FIXTURE}`);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('adds the column once, keeps the values on a second paste, and the live build keeps working', () => {
    psql(`drop database if exists ${FIXTURE}`);
    psql(`create database ${FIXTURE}`);
    scratch = mkdtempSync(join(tmpdir(), 'lp-location-'));
    const released = join(scratch, 'rework-f1.sql');
    const releasedSql = execFileSync('git', ['show', `${RELEASED}:${REWORK}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    expect(releasedSql).not.toContain('medical_location');
    writeFileSync(released, releasedSql);
    for (const file of readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()) {
      applyPath(file.startsWith('20261106000000') ? released : join(ROOT, 'supabase/migrations', file));
    }
    // Rows the live build wrote through the released functions.
    sqlIn(`set role service_role;
      select lp_create_request('{"client_mutation_id":"00000000-0000-4000-8000-0000000000f1","reporting_location":"Base","first_name":"TEST-loc-1"}', 'T · Medical');
      select lp_create_request('{"client_mutation_id":"00000000-0000-4000-8000-0000000000f2","reporting_location":"Command","first_name":"TEST-loc-2"}', 'T · Medical');`);
    expect(column()).toBe('missing');

    applyPath(join(ROOT, REWORK));
    expect(column()).toBe('text/YES');
    expect(sqlIn("select count(*) from patients where medical_location is not null")).toBe('0');
    // Set through the new lp_update_fields, then paste the file again: nothing is lost.
    expect(sqlIn(`set role service_role;
      select lp_update_fields(id, '{"medical_location": "Chair 14"}', row_version, 'T · Medical') -> 'row' ->> 'medical_location'
      from patients where first_name = 'TEST-loc-1'`)).toBe('Chair 14');
    applyPath(join(ROOT, REWORK));
    expect(column()).toBe('text/YES');
    expect(sqlIn("select string_agg(first_name || '=' || coalesce(medical_location, 'null'), ' ' order by first_name) from patients where first_name like 'TEST-loc-%'"))
      .toBe('TEST-loc-1=Chair 14 TEST-loc-2=null');

    // What the live build calls, unchanged: an edit without the field, an answer, sync. The location stays.
    expect(sqlIn(`set role service_role;
      select (lp_update_fields(id, '{"clothing": "TEST red hoodie", "age": 24}', row_version, 'T · Medical') -> 'row') ->> 'medical_location'
      from patients where first_name = 'TEST-loc-1'`)).toBe('Chair 14');
    expect(sqlIn(`set role service_role;
      select lp_set_status(id, row_version, 'Found – Awaiting Reunion', 'T · Medical', 'answer') -> 'row' ->> 'status'
      from patients where first_name = 'TEST-loc-1'`)).toBe('Found – Awaiting Reunion');
    expect(sqlIn(`set role service_role;
      select string_agg((r ->> 'first_name') || ':' || coalesce(r ->> 'medical_location', 'null') || ':' || (r ? 'medical_location')::text, ' ' order by r ->> 'first_name')
      from jsonb_array_elements(lp_sync(null) -> 'rows') r`)).toBe('TEST-loc-1:Chair 14:true TEST-loc-2:null:true');
    // The audit trail of the location edit is an ordinary patient_updated row.
    expect(sqlIn(`select string_agg(previous_value::text || ' -> ' || new_value::text, ' | ' order by occurred_at)
      from audit_events a join patients p on p.id = a.patient_id
      where p.first_name = 'TEST-loc-1' and a.action_type = 'patient_updated' and a.new_value ? 'medical_location'`))
      .toBe('{"medical_location": null} -> {"medical_location": "Chair 14"}');
  }, 120_000);
});
