// GET /api/stats (spec §8 Dashboard, A21, A31, A48, A49; Events "Stats"): lp_stats(p_event, p_range) for the session's
// event. No range: the live snapshot (Stats' base fields, names in recent). ?range=1h|2h|6h|today|event|day:N: the
// snapshot with names out plus the dashboard fields (EventStats), in the event's time zone and show day; post
// breakdowns are arrays ordered by count, never fixed FA 3 / FA 4 keys. F3: plus friendsEnRoute and avgArriveMinutes
// from lp_enroute_stats(p_event), left out when that can't be read (the dashboard shows "—"). Every 200 carries a weak
// ETag over the body without serverTime; a poll sending it back in If-None-Match gets a 304 with no body.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EventStats } from '@/lib/api-types';
import { ApiFailure } from '@/lib/server/errors';
import { json, NO_STORE, parseQuery } from '@/lib/server/http';
import { readEnrouteStats } from '@/lib/server/messages';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const query = z.object({ range: z.string().regex(/^(1h|2h|6h|today|event|day:[1-9][0-9]{0,2})$/).optional() });

/** A weak ETag over everything but serverTime (which changes on every call). */
function statsEtag(body: Record<string, unknown>): string {
  const { serverTime: _ignored, ...rest } = body;
  return `W/"${createHash('sha1').update(JSON.stringify(rest)).digest('base64url').slice(0, 27)}"`;
}

export const GET = authedRoute('GET /api/stats', {}, async ({ request, eventId }) => {
  const { range } = parseQuery(new URL(request.url).searchParams, query);
  const [stats, enroute] = await Promise.all([
    rpc<EventStats | null>('lp_stats', { p_event: eventId, p_range: range ?? null }),
    readEnrouteStats(eventId),
  ]);
  if (!stats || typeof stats !== 'object') throw new ApiFailure('unavailable', undefined, { dbCode: 'stats_shape' });
  const body = { ...stats, ...enroute };
  const etag = statsEtag(body);
  const asked = request.headers.get('if-none-match');
  if (asked && asked.split(',').some((t) => t.trim() === etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': NO_STORE } });
  }
  return json(body, 200, { ETag: etag });
});
