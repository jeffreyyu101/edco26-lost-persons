// GET /api/stats (spec §8 Dashboard, A21, A31, A48, A49): lp_stats() is already camelCase (Stats), including
// avgReuniteMinutes and loggedLastHour since the v2.5 re-run of the rework migration.
import type { Stats } from '@/lib/api-types';
import { ApiFailure } from '@/lib/server/errors';
import { json } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute('GET /api/stats', {}, async () => {
  const stats = await rpc<Stats | null>('lp_stats', {});
  if (!stats || typeof stats !== 'object') throw new ApiFailure('unavailable', undefined, { dbCode: 'stats_shape' });
  return json(stats);
});
