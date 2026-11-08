// GET /api/stats (spec §8 Dashboard, A21, A31, A48, A49): lp_stats() is already camelCase (Stats), including
// avgReuniteMinutes and loggedLastHour since the v2.5 re-run of the rework migration.
// F3 (spec §18 A58): plus friendsEnRoute and avgArriveMinutes from lp_enroute_stats(), additive; left out
// when that can't be read (the dashboard shows "—").
// Dashboard v4 (2026-11-08): ?range=1h|2h|6h|tonight|event calls lp_stats(p_range) (20261108000000_dashboard_v4.sql),
// every field above plus the v4 ones, with no names (recent[].name is null). No range: exactly as before, so a
// deployed build keeps working whichever ships first. A database without lp_stats(text) yet answers the old fields
// (names out). Every 200 carries a weak ETag over the body without serverTime; a poll sending it back in
// If-None-Match gets a 304 with no body while nothing changed.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Stats } from '@/lib/api-types';
import { ApiFailure } from '@/lib/server/errors';
import { json, NO_STORE, parseQuery } from '@/lib/server/http';
import { readEnrouteStats } from '@/lib/server/messages';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { STATS_RANGES } from '@/lib/stats-range';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const query = z.object({ range: z.enum(STATS_RANGES).optional() });
/** PostgREST "no such function" / Postgres undefined_function: the v4 migration is not there yet. */
const MISSING_FUNCTION = new Set(['PGRST202', '42883']);

async function rangedStats(range: (typeof STATS_RANGES)[number]): Promise<Stats | null> {
  try {
    return await rpc<Stats | null>('lp_stats', { p_range: range });
  } catch (error) {
    if (!(error instanceof ApiFailure) || !MISSING_FUNCTION.has(error.dbCode ?? '')) throw error;
    const old = await rpc<Stats | null>('lp_stats', {});
    return old && typeof old === 'object' ? { ...old, recent: (old.recent ?? []).map((r) => ({ ...r, name: null })) } : old;
  }
}

/** A weak ETag over everything but serverTime (which changes on every call). */
function statsEtag(body: Record<string, unknown>): string {
  const { serverTime: _ignored, ...rest } = body;
  return `W/"${createHash('sha1').update(JSON.stringify(rest)).digest('base64url').slice(0, 27)}"`;
}

export const GET = authedRoute('GET /api/stats', {}, async ({ request }) => {
  const { range } = parseQuery(new URL(request.url).searchParams, query);
  const [stats, enroute] = await Promise.all([range ? rangedStats(range) : rpc<Stats | null>('lp_stats', {}), readEnrouteStats()]);
  if (!stats || typeof stats !== 'object') throw new ApiFailure('unavailable', undefined, { dbCode: 'stats_shape' });
  const body = { ...stats, ...enroute };
  const etag = statsEtag(body);
  const asked = request.headers.get('if-none-match');
  if (asked && asked.split(',').some((t) => t.trim() === etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': NO_STORE } });
  }
  return json(body, 200, { ETag: etag });
});
