// One taxonomy everywhere (design §1.4): lib/telemetry.ts's names equal the design document's event tables, the ingest
// schema accepts exactly the client ones, and the token regex is the same in TS, zod and SQL (read from the migration).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGGREGATES, CRUMB_SOURCE, EVENT_NAMES, FRUSTRATION, HEALTH_WINDOWS, PROP_KEYS, SERVER_ONLY_EVENTS, TEL_KEYS, TOKEN_SOURCE, VIEWS } from '@/lib/telemetry';
import { HEALTH_SEEN_KEY, WINDOWS } from '@/components/health/health-model';
import { parseBatch } from '@/lib/server/telemetry';

const root = new URL('../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

const envelope = (ev: unknown[]) => JSON.stringify({ v: 1, b: 'batch0000001', d: 'device0000000001', s: 'sess000001', sent: 1_762_600_000_000, ctx: { plat: 'ios', osv: 18, eng: 'webkit', sa: true, lay: 'phone', dpr: 3, touch: true, build: 'none', eff: 'na', mem: -1 }, ev });

describe('the event taxonomy', () => {
  it('37 names, equal to the design document’s §1.4 tables', () => {
    const doc = read('design/references/observability-design.md');
    const section = doc.slice(doc.indexOf('### 1.4 Events'), doc.indexOf('### 1.5'));
    const names = [...section.matchAll(/^\| `([a-z_]+)`/gm)].map((m) => m[1]).filter((n) => n !== 'n'); // the header row's column
    expect(EVENT_NAMES).toHaveLength(37);
    expect(new Set(names)).toEqual(new Set(EVENT_NAMES));
    expect(section).toContain('That is 37 names');
  });

  it('frustration, aggregates and server-only names are event names; views are the nav views plus unknown', () => {
    for (const n of [...FRUSTRATION, ...AGGREGATES, ...SERVER_ONLY_EVENTS]) expect(EVENT_NAMES).toContain(n);
    expect(FRUSTRATION).toEqual(['stuck_scroll', 'rage_tap', 'dead_tap', 'loop', 'slow', 'pinch', 'error', 'stuck_send']);
    expect(VIEWS).toEqual(['all', 'pending', 'mine', 'search', 'new', 'profile', 'edit', 'dashboard', 'outbox', 'unknown']);
    expect(new Set(PROP_KEYS).size).toBe(PROP_KEYS.length);
  });

  it('the ingest schema accepts every client event name and refuses the server-only ones', () => {
    const at = 1_762_600_000_000;
    const client = EVENT_NAMES.filter((n) => !SERVER_ONLY_EVENTS.includes(n));
    const parsed = parseBatch(envelope([...client.map((n) => ({ n, at })), ...SERVER_ONLY_EVENTS.map((n) => ({ n, at }))]));
    expect(parsed.ev.map((e) => e.n)).toEqual(client);
    expect(parsed.rejected).toBe(SERVER_ONLY_EVENTS.length);
  });

  it('the token regex is identical in TS, zod and the SQL CHECKs; trail codes use the crumb pattern', () => {
    const sql = read('supabase/migrations/20261106000000_rework.sql');
    const section = sql.slice(sql.indexOf('-- 10. Telemetry'));
    expect(section).toContain(`area text check (area ~ '${TOKEN_SOURCE}')`);
    expect(section).toContain(`ctl text check (ctl ~ '${TOKEN_SOURCE}')`);
    const server = read('lib/server/telemetry.ts');
    expect(server).toContain('z.string().regex(TOKEN_RE)');
    expect(server).toContain('z.string().regex(CRUMB_RE)');
    expect(CRUMB_SOURCE.replace('>+!^', '')).toBe(TOKEN_SOURCE);
  });

  it('the Health page’s own copies of the windows and the device key equal lib/telemetry.ts', () => {
    expect(WINDOWS).toEqual(HEALTH_WINDOWS);
    expect(HEALTH_SEEN_KEY).toBe(TEL_KEYS.health);
    expect(read('components/desk/Nav.tsx')).toContain(`'${TEL_KEYS.health}'`);
  });
});
