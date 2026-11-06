// The rework migration (spec §5, A9, A30, A35, A36): applied twice on the migrated app database and on an
// upgrade fixture built from Jeffrey's original schema (legacy column, legacy rows, legacy audit formats,
// old CHECKs), with smoke checks. Wraps scripts/verify-migration.sh (LOCAL ONLY; it has its own host
// guard). Afterwards PostgREST must have reloaded its schema before other tests run.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../scripts/test-env.mjs';
import { admin, psql } from './harness';

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
    const { stdout } = await run('bash', ['scripts/verify-migration.sh'], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024, timeout: 120_000 });
    expect(stdout).toContain('re-apply #1: ok');
    expect(stdout).toContain('re-apply #2: ok');
    expect(stdout).toContain('apply #1: ok');
    expect(stdout).toContain('apply #2: ok');
    expect(stdout).toContain('lp_stats byPost adds up to open: ok');
    expect(stdout).toContain('verify-migration: all good');
    await waitForSchema();
  }, 150_000);

  it('the scratch fixture database is dropped afterwards', () => {
    expect(psql("select count(*) from pg_database where datname = 'lp_upgrade_fixture'")).toBe('0');
  });

  it('the app database has the rework objects', () => {
    expect(psql("select count(*) from information_schema.columns where table_name = 'patients' and column_name in ('row_version', 'last_seen')")).toBe('2');
    expect(psql("select count(*) from information_schema.columns where table_name = 'patient_photos' and column_name = 'thumb_path'")).toBe('1');
    expect(psql("select tgname from pg_trigger where tgrelid = 'public.patients'::regclass and tgname = 'lp_patients_touch'")).toBe('lp_patients_touch');
    // Mutating RPCs carry the function-level timeouts (A7).
    const cfg = psql("select proconfig::text from pg_proc where proname = 'lp_set_status'");
    expect(cfg).toContain('statement_timeout=4s');
    expect(cfg).toContain('lock_timeout=2s');
  });
});
