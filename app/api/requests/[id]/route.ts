// GET /api/requests/:id (RequestDetail through lp_detail) and PATCH /api/requests/:id (lp_update_fields).
import type { ChangeResponse, RequestDetail } from '@/lib/api-types';
import { idParam, json, readJson } from '@/lib/server/http';
import { mapDetail, mapRow, patchPayload } from '@/lib/server/mappers';
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
  return json(out);
});
