// POST /api/requests/:id/messages/:messageId/unsend (lp_unsend_message): the sender takes a message back
// within 15 minutes (403 for someone else's, 422 too_late after, 404 when it is not this request's). It
// disappears from every thread, count and preview, and stays in the audit trail and the export. Repeats →
// 200 {changed: false}. No notification.
import type { ActivityResponse } from '@/lib/api-types';
import { ApiFailure } from '@/lib/server/errors';
import { json } from '@/lib/server/http';
import { mapActivity } from '@/lib/server/messages';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { messageParamsSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = { id: string; messageId: string };

export const POST = authedRoute<P>('POST /api/requests/[id]/messages/[messageId]/unsend', {}, async ({ params, session }) => {
  const parsed = messageParamsSchema.safeParse({ id: params.id, messageId: params.messageId });
  if (!parsed.success) throw new ApiFailure('not_found');
  const data = await rpc<{ changed?: unknown; activity?: unknown }>('lp_unsend_message', {
    p_request: parsed.data.id.toLowerCase(),
    p_message: parsed.data.messageId.toLowerCase(),
    p_staff: session.staff,
  });
  const out: ActivityResponse = { changed: data.changed === true, activity: mapActivity(data.activity) };
  return json(out);
});
