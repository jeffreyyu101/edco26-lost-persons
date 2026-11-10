// GET /api/telemetry/health?window=1h|3h|12h|all (design §3, §5.3): the Health page's data. Every section is one
// lp_tel_health() call; a section that fails or times out is null (its panel shows "—") while the others render.
// `all` is the last 30 days (what retention keeps). Loaded on the page's mount and its Refresh only.
//
// The live app shares PostgREST's pool and the database's CPU with these aggregates, so they never run all at once:
// at most SECTION_CONCURRENCY sections at a time, one computation per window shared by every request that arrives
// while it runs, and `all` (the whole table: no index helps) kept for ALL_CACHE_MS. The config is always read fresh
// (its own 30 s cache, cleared by the kill switch), so a flip shows on the next Refresh.
import { HEALTH_SECTIONS, HEALTH_WINDOWS, type HealthSection, type HealthWindow } from '@/lib/telemetry';
import { json } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { telemetryConfig } from '@/lib/server/telemetry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WINDOW_MS: Readonly<Record<HealthWindow, number>> = {
  '1h': 3_600_000,
  '3h': 3 * 3_600_000,
  '12h': 12 * 3_600_000,
  all: 30 * 24 * 3_600_000,
};

const SECTION_CONCURRENCY = 2;
const ALL_CACHE_MS = 30_000;

type Sections = Record<HealthSection, unknown>;
const computed = new Map<string, { at: number; done: boolean; value: Promise<Sections> }>();

async function loadSections(eventId: string, since: string): Promise<Sections> {
  const out: unknown[] = HEALTH_SECTIONS.map(() => null);
  let next = 0;
  const worker = async () => {
    while (next < HEALTH_SECTIONS.length) {
      const i = next;
      next += 1;
      out[i] = await rpc<unknown>('lp_tel_health', { p_event: eventId, p_section: HEALTH_SECTIONS[i], p_since: since, p_limit: 50 }).then(
        (data) => data ?? null,
        () => null,
      );
    }
  };
  await Promise.all(Array.from({ length: SECTION_CONCURRENCY }, worker));
  return Object.fromEntries(HEALTH_SECTIONS.map((s, i) => [s, out[i] ?? null])) as Sections;
}

/** The sections for a window and when they were read (a shared or cached answer keeps its own time). */
function sectionsFor(eventId: string, window: HealthWindow, now: number): { at: number; value: Promise<Sections> } {
  const key = `${eventId}:${window}`;
  const hit = computed.get(key);
  if (hit && (!hit.done || (window === 'all' && now - hit.at < ALL_CACHE_MS))) return hit;
  const entry = { at: now, done: false, value: loadSections(eventId, new Date(now - WINDOW_MS[window]).toISOString()) };
  void entry.value.finally(() => {
    entry.done = true;
  });
  computed.set(key, entry);
  return entry;
}

export const GET = authedRoute('GET /api/telemetry/health', {}, async ({ request, eventId, event }) => {
  const asked = new URL(request.url).searchParams.get('window');
  const window: HealthWindow = (HEALTH_WINDOWS as readonly string[]).includes(asked ?? '') ? (asked as HealthWindow) : '3h';
  const read = sectionsFor(eventId, window, Date.now());
  const [config, sections] = await Promise.all([telemetryConfig().catch(() => null), read.value]);
  // (Events) The event's team names (the sections key teams by EventTeam.id) and its time zone, for the page's labels.
  const teams = (event?.teams ?? []).map((t) => ({ id: String(t.id ?? ''), short: String(t.short || t.label || t.id || '') })).filter((t) => t.id);
  return json({ generatedAt: new Date(read.at).toISOString(), window, config, ...sections, teams, timeZone: event?.timezone ?? null });
});
