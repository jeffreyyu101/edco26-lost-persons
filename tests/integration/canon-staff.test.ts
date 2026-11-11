// SQL side of the canonStaff contract (spec §4): lp_canon_staff must give exactly what domain.canonStaff
// gives for the shared fixtures. Runs against the LOCAL stack only (tests/helpers/integration-setup.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { canonStaff } from '@/lib/domain';
import { TEST_EVENT_ID as EVENT_ID } from '../../scripts/test-env.mjs';

const fixtures = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'canon-staff.json'), 'utf8')) as Array<{
  input: string;
  expected: string;
}>;

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL as string, process.env.SUPABASE_SECRET_KEY as string, {
  auth: { persistSession: false, autoRefreshToken: false },
});

describe('lp_canon_staff (SQL) = canonStaff (TypeScript)', () => {
  it.each(fixtures)('$input', async ({ input, expected }) => {
    const { data, error } = await db.rpc('lp_canon_staff', { p: input });
    expect(error).toBeNull();
    expect(data).toBe(expected);
    expect(canonStaff(input)).toBe(expected);
  });
});

describe('function privileges', () => {
  it('anon cannot execute the lp_* functions', async () => {
    const key = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!key) return; // optional in .env.test; the service-role checks above still run
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL as string, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await anon.rpc('lp_stats', { p_event: EVENT_ID });
    expect(error?.code).toBe('42501');
  });
});
