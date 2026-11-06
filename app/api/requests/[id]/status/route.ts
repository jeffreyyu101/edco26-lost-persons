// POST /api/requests/:id/status (lp_set_status). Idempotent repeat → 200 {changed: false}; stale
// expectedVersion → 409 (currentStatus); illegal transition → 422; Cancelled → Waiting by a non-creator → 403.
import type { ChangeResponse } from '@/lib/api-types';
import { idParam, json, readJson } from '@/lib/server/http';
import { mapRow } from '@/lib/server/mappers';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { setStatusSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute<{ id: string }>('POST /api/requests/[id]/status', {}, async ({ request, params, session }) => {
  const id = idParam(params);
  const body = await readJson(request, setStatusSchema);
  const data = await rpc<{ changed?: unknown; row?: unknown }>('lp_set_status', {
    p_id: id,
    p_expected_version: body.expectedVersion,
    p_status: body.status,
    p_staff: session.staff,
    p_kind: body.kind,
  });
  const out: ChangeResponse = { changed: data.changed === true, request: mapRow(data.row) };
  return json(out);
});
