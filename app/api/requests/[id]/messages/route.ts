// GET /api/requests/:id/messages (lp_messages_thread): the latest 100 messages, oldest first, with the
// receipt under the caller's latest one; ?beforeAt&beforeId pages back ("Earlier messages").
// POST /api/requests/:id/messages (lp_post_message): one message, idempotent on clientMutationId (201 when
// created, 200 for a retry). 20 a minute per staff (429 + Retry-After). A new message tells everyone
// involved (contract D), after the response.
import type { PostMessageResponse, ThreadPage } from '@/lib/api-types';
import { idParam, json, parseQuery, readJson } from '@/lib/server/http';
import { mapActivity, mapMessage, mapThread, messageEvent, notifyInvolved, recipientsOf } from '@/lib/server/messages';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { postMessageSchema, threadQuerySchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = { id: string };

export const GET = authedRoute<P>('GET /api/requests/[id]/messages', {}, async ({ request, params, session }) => {
  const id = idParam(params);
  const q = parseQuery(new URL(request.url).searchParams, threadQuerySchema);
  const page: ThreadPage = mapThread(
    await rpc<unknown>('lp_messages_thread', {
      p_request: id,
      p_staff: session.staff,
      p_before_at: q.beforeAt ?? null,
      p_before_id: q.beforeId ?? null,
    }),
  );
  return json(page);
});

export const POST = authedRoute<P>('POST /api/requests/[id]/messages', {}, async ({ request, params, session }) => {
  const id = idParam(params);
  const body = await readJson(request, postMessageSchema);
  const data = await rpc<{ created?: unknown; message?: unknown; activity?: unknown; recipients?: unknown }>(
    'lp_post_message',
    {
      p_request: id,
      p_body: body.body,
      p_client_mutation_id: body.clientMutationId,
      p_staff: session.staff,
      p_team: session.claims.team,
    },
    'message',
  );
  const out: PostMessageResponse = { created: data.created === true, message: mapMessage(data.message), activity: mapActivity(data.activity) };
  if (out.created) await notifyInvolved(recipientsOf(data.recipients), messageEvent(id, session.staff, out.message.body));
  return json(out, out.created ? 201 : 200);
});
