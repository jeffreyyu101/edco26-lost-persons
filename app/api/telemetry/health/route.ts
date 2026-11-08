// GET /api/telemetry/health?window=1h|3h|12h|all (design §3, §5.3): the Health page's data. Every section is one
// lp_tel_health() call, all in parallel; a section that fails or times out is null (its panel shows "—") while the
// others render. `all` is the last 30 days (what retention keeps). Loaded on the page's mount and its Refresh only.
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

export const GET = authedRoute('GET /api/telemetry/health', {}, async ({ request }) => {
  const asked = new URL(request.url).searchParams.get('window');
  const window: HealthWindow = (HEALTH_WINDOWS as readonly string[]).includes(asked ?? '') ? (asked as HealthWindow) : '3h';
  const since = new Date(Date.now() - WINDOW_MS[window]).toISOString();
  const [config, ...sections] = await Promise.all([
    telemetryConfig(),
    ...HEALTH_SECTIONS.map((section) =>
      rpc<unknown>('lp_tel_health', { p_section: section, p_since: since, p_limit: 50 }).then(
        (data) => data ?? null,
        () => null,
      ),
    ),
  ]);
  const out = Object.fromEntries(HEALTH_SECTIONS.map((s: HealthSection, i) => [s, sections[i] ?? null]));
  return json({ generatedAt: new Date().toISOString(), window, config, ...out });
});
