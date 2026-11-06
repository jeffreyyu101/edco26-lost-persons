// The deploy docs must match the repo (spec §10: HANDOFF.md replaced, README.md updated). A deployer who
// follows README.md / HANDOFF.md must find every file they name, paste the rework migration, and set every
// variable the server validates. Reads the docs and the repo only.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');
const readme = read('README.md');
const handoff = read('HANDOFF.md');
const migrations = readdirSync(`${root}supabase/migrations`).filter((f) => f.endsWith('.sql')).sort();
const REWORK = '20261106000000_rework.sql';

describe('README.md and HANDOFF.md', () => {
  it('every migration file they name exists', () => {
    for (const [name, doc] of [['README.md', readme], ['HANDOFF.md', handoff]] as const) {
      const named = [...doc.matchAll(/(\d{8,14}_[a-z0-9_]+\.sql)/g)].map((m) => m[1] as string);
      expect(named.length, name).toBeGreaterThan(0);
      for (const file of named) expect(migrations, `${name} names ${file}`).toContain(file);
      for (const [, path] of doc.matchAll(/\((supabase\/migrations\/[^)]+)\)/g)) expect(existsSync(`${root}${path}`), `${name} links ${path}`).toBe(true);
    }
  });

  it('README lists the whole migration chain, in order, and both docs point at the rework file', () => {
    expect(migrations).toContain(REWORK);
    const positions = migrations.map((f) => readme.indexOf(f));
    expect(positions.every((p) => p >= 0), `README lists ${migrations.join(', ')}`).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(handoff).toContain(REWORK);
  });

  it('README covers every environment variable in .env.example', () => {
    const vars = [...read('.env.example').matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1] as string);
    expect(vars.length).toBeGreaterThanOrEqual(6);
    for (const v of vars) expect(readme, v).toContain(v);
  });

  it('README gives the local test workflow with scripts that exist', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    for (const s of ['db:reset', 'build:test', 'test:int', 'test:e2e']) {
      expect(scripts[s], s).toBeTruthy();
      expect(readme, s).toContain(`npm run ${s}`);
    }
  });

  it('HANDOFF has the dry run then commit, the Vercel notes and the morning checklist', () => {
    expect(handoff).toMatch(/rollback/);
    expect(handoff.indexOf('Dry run')).toBeLessThan(handoff.indexOf('**Commit.**'));
    expect(handoff).toMatch(/Fluid compute/);
    expect(handoff).toMatch(/Region/);
    expect(handoff).toMatch(/Known limits/);
    // Spec §11 has ten manual checks.
    expect((handoff.match(/^- \[ \] /gm) ?? []).length).toBeGreaterThanOrEqual(10);
  });

  it('neither doc describes the removed app', () => {
    for (const doc of [readme, handoff]) {
      expect(doc).not.toMatch(/15-second refresh|manual refresh,|localhost:3000|save on profile close|URL normalization only/i);
      expect(doc).not.toMatch(/20261105_(add_last_seen|update_locations_and_statuses)\.sql/);
      // v2.5 (A50): the Export CSV button and GET /api/export are gone; docs/export.sql replaces them.
      expect(doc).not.toMatch(/Export CSV|\/api\/export/i);
    }
  });

  it('both docs point at docs/export.sql for the end-of-event export, and it exists', () => {
    expect(existsSync(`${root}docs/export.sql`)).toBe(true);
    expect(readme).toContain('docs/export.sql');
    expect(handoff).toMatch(/^- \[ \] At the end, run `?docs\/export\.sql`? in the SQL editor and download the results/m);
  });
});
