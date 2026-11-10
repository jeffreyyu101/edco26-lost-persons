// POST /api/requests/:id/cancel (lp_cancel): creator only (403), only while Waiting (422), version-checked
// (409). Repeating a cancel that already happened → 200 {changed: false}. A real cancel tells everyone else
// involved (Activity + Web Push, F4 spec §18 A57), after the response.
import { closedDetail } from '@/lib/activity';
import type { ChangeResponse } from '@/lib/api-types';
import { idParam, json, readJson } from '@/lib/server/http';
import { involvedStaff } from '@/lib/server/involved';
import { mapRow } from '@/lib/server/mappers';
import { notifyLater } from '@/lib/server/notify';
import { withReclassify } from '@/lib/server/reclassify';
import { postNames } from '@/lib/server/events';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { cancelSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute<{ id: string }>('POST /api/requests/[id]/cancel', {}, async ({ request, params, session, eventId, event }) => {
  const id = idParam(params);
  const body = await readJson(request, cancelSchema);
  const data = await withReclassify(eventId, id, { fn: 'cancel', expectedVersion: body.expectedVersion }, () =>
    rpc<{ changed?: unknown; row?: unknown }>('lp_cancel', {
      p_event: eventId,
      p_id: id,
      p_expected_version: body.expectedVersion,
      p_staff: session.staff,
    }),
  );
  const out: ChangeResponse = { changed: data.changed === true, request: mapRow(data.row, postNames(event)) };
  if (out.changed) {
    await notifyLater(eventId, () => involvedStaff(eventId, id), () => ({ requestId: id, kind: 'cancelled', actor: session.staff, detail: closedDetail('cancelled') }));
  }
  return json(out);
});
