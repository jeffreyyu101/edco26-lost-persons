// POST /api/requests/:id/cancel (lp_cancel): creator only (403), only while Waiting (422), version-checked
// (409). Repeating a cancel that already happened → 200 {changed: false}.
import type { ChangeResponse } from '@/lib/api-types';
import { idParam, json, readJson } from '@/lib/server/http';
import { mapRow } from '@/lib/server/mappers';
import { withReclassify } from '@/lib/server/reclassify';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { cancelSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute<{ id: string }>('POST /api/requests/[id]/cancel', {}, async ({ request, params, session }) => {
  const id = idParam(params);
  const body = await readJson(request, cancelSchema);
  const data = await withReclassify(id, { fn: 'cancel', expectedVersion: body.expectedVersion }, () =>
    rpc<{ changed?: unknown; row?: unknown }>('lp_cancel', {
      p_id: id,
      p_expected_version: body.expectedVersion,
      p_staff: session.staff,
    }),
  );
  const out: ChangeResponse = { changed: data.changed === true, request: mapRow(data.row) };
  return json(out);
});
