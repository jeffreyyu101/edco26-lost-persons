// GET /api/requests/:id (RequestDetail through lp_detail) and PATCH /api/requests/:id (lp_update_fields).
// A real edit tells everyone involved (Activity + Web Push, F4 spec §18 A57), after the response: where
// medical has them as "Chair 9 → Bed 3" (or the In medical answer completed with it, "In medical · Chair 9"),
// anything else as "Details changed".
import type { ChangeResponse, RequestDetail } from '@/lib/api-types';
import { editEventFor } from '@/lib/server/activity-events';
import { idParam, json, readJson } from '@/lib/server/http';
import { involvedStaff } from '@/lib/server/involved';
import { mapDetail, mapRow, patchPayload } from '@/lib/server/mappers';
import { notifyLater } from '@/lib/server/notify';
import { withReclassify } from '@/lib/server/reclassify';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { updateRequestSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = { id: string };

export const GET = authedRoute<P>('GET /api/requests/[id]', {}, async ({ params }) => {
  const id = idParam(params);
  const detail: RequestDetail = mapDetail(await rpc<unknown>('lp_detail', { p_id: id }));
  return json(detail);
});

export const PATCH = authedRoute<P>('PATCH /api/requests/[id]', {}, async ({ request, params, session }) => {
  const id = idParam(params);
  const body = await readJson(request, updateRequestSchema);
  const data = await withReclassify(id, { fn: 'update', expectedVersion: body.expectedVersion }, () =>
    rpc<{ changed?: unknown; row?: unknown }>('lp_update_fields', {
      p_id: id,
      p_patch: patchPayload(body.patch),
      p_expected_version: body.expectedVersion,
      p_staff: session.staff,
    }),
  );
  const out: ChangeResponse = { changed: data.changed === true, request: mapRow(data.row) };
  if (out.changed) {
    const status = out.request.status;
    await notifyLater(() => involvedStaff(id), () => editEventFor(id, session.staff, status));
  }
  return json(out);
});
