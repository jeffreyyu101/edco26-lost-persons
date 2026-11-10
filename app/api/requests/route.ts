// POST /api/requests (spec §6, A19): idempotent create on clientMutationId. 201 when created, 200 when a
// request with that clientMutationId already existed (a retry). Attribution comes from the session.
// A real create tells everyone whose "New requests" switch is on (Activity + Web Push, F4 spec §18 A57),
// after the response; a retry tells nobody again.
import { newRequestDetail } from '@/lib/activity';
import type { CreateResponse } from '@/lib/api-types';
import { json, readJson } from '@/lib/server/http';
import { newRequestStaff } from '@/lib/server/involved';
import { createPayload, mapRow } from '@/lib/server/mappers';
import { notifyLater } from '@/lib/server/notify';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { createRequestSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute('POST /api/requests', {}, async ({ request, session, eventId }) => {
  const input = await readJson(request, createRequestSchema);
  const data = await rpc<{ created?: unknown; row?: unknown }>('lp_create_request', {
    p_event: eventId,
    p: createPayload(input),
    p_staff: session.staff,
  });
  const body: CreateResponse = { created: data.created === true, request: mapRow(data.row) };
  if (body.created) {
    const row = body.request;
    await notifyLater(eventId, () => newRequestStaff(eventId), () => ({ requestId: row.id, kind: 'new_request', actor: session.staff, detail: newRequestDetail(row) }));
  }
  return json(body, body.created ? 201 : 200);
});
