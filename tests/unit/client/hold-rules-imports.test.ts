// The F5 release (spec §20 A71): what keeps the first load of `/` within A25's 230 KB. The store loads the hold's
// client rules with import(); an import() whose module reaches lib/domain.ts or lib/format.ts at run time, or a new
// import edge between those two, makes Turbopack split the first-load chunk they live in (about 1 KB gzipped).
// tests/e2e/first-load.spec.ts measures the result; these name the cause when it comes back. Reads source only.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HOLD_DOMAIN, notFoundSnack, statusOverlayFields } from '@/lib/client/hold';
import { holdRules } from '@/lib/client/hold-rules';
import { RECHECK_MINUTES, STATUS } from '@/lib/domain';

const source = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const imports = (path: string) => source(path).match(/^import\b[^;]*;/gm) ?? [];

describe('the first-load budget (A71)', () => {
  it('lib/client/hold-rules.ts imports types only', () => {
    const lines = imports('lib/client/hold-rules.ts');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^import type /);
  });

  it('the store loads the rules with import() and never imports lib/client/hold.ts', () => {
    const store = source('lib/client/store-core.ts');
    expect(store).toContain("import('./hold-rules')");
    expect(store).not.toMatch(/from '\.\/hold'/);
    for (const line of imports('lib/client/store-core.ts').filter((l) => l.includes("'./hold-rules'"))) expect(line).toMatch(/^import type /);
  });

  it('lib/domain.ts imports nothing (holdDetail lives in lib/hold-detail.ts)', () => {
    expect(imports('lib/domain.ts')).toEqual([]);
  });

  it('the rules bound as lib/client/hold.ts binds them answer as before', () => {
    const rules = holdRules(HOLD_DOMAIN);
    const now = Date.parse('2026-11-06T21:31:00Z');
    const row = { status: STATUS.waiting, notFoundChecks: 0, recheckAt: null, name: 'Bea Walsh', caseNumber: 1010 } as Parameters<typeof statusOverlayFields>[0];
    expect(rules.statusOverlayFields(row, STATUS.notInMedical, 'answer', now)).toEqual(statusOverlayFields(row, STATUS.notInMedical, 'answer', now));
    expect(rules.statusOverlayFields(row, STATUS.notInMedical, 'answer', now)).toEqual({
      recheckAt: new Date(now + RECHECK_MINUTES * 60_000).toISOString(),
      notFoundChecks: 1,
    });
    const closed = { ...row, status: STATUS.notInMedical, notFoundChecks: 2 };
    expect(rules.notFoundSnack(closed, STATUS.notInMedical)).toEqual(notFoundSnack(closed, STATUS.notInMedical));
  });
});
