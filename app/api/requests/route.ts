// POST /api/requests (spec §6, A19): idempotent create on clientMutationId. 201 when created, 200 when a
// request with that clientMutationId already existed (a retry). Attribution comes from the session.
import type { CreateResponse } from '@/lib/api-types';
import { json, readJson } from '@/lib/server/http';
import { createPayload, mapRow } from '@/lib/server/mappers';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { createRequestSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute('POST /api/requests', {}, async ({ request, session }) => {
  const input = await readJson(request, createRequestSchema);
  const data = await rpc<{ created?: unknown; row?: unknown }>('lp_create_request', {
    p: createPayload(input),
    p_staff: session.staff,
  });
  const body: CreateResponse = { created: data.created === true, request: mapRow(data.row) };
  return json(body, body.created ? 201 : 200);
});
