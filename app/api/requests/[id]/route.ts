// GET /api/requests/:id (RequestDetail through lp_detail) and PATCH /api/requests/:id (lp_update_fields).
// F3: the detail also carries the thread's latest page (lp_messages_thread) and the caller's activity; when
// the thread can't be read the detail goes out without it.
// A real edit tells everyone involved (Activity + Web Push, F4 spec §22 A86), after the response: where
// medical has them as "Chair 9 → Bed 3" (or the In medical answer completed with it, "In medical · Chair 9"),
// anything else as "Details changed".
import type { ChangeResponse, RequestDetail } from '@/lib/api-types';
import { editEventFor } from '@/lib/server/activity-events';
import { idParam, json, readJson } from '@/lib/server/http';
import { involvedStaff } from '@/lib/server/involved';
import { mapDetail, mapRow, patchPayload } from '@/lib/server/mappers';
import { readThread, withActivity } from '@/lib/server/messages';
import { notifyLater } from '@/lib/server/notify';
import { withReclassify } from '@/lib/server/reclassify';
import { postNames, teamNames } from '@/lib/server/events';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { updateRequestSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = { id: string };

export const GET = authedRoute<P>('GET /api/requests/[id]', {}, async ({ params, session, eventId, event }) => {
  const id = idParam(params);
  const [raw, thread] = await Promise.all([rpc<unknown>('lp_detail', { p_event: eventId, p_id: id }), readThread(eventId, id, session.staff, teamNames(event))]);
  const base = mapDetail(raw, postNames(event));
  const detail: RequestDetail = thread ? { ...(withActivity(base, thread.activity) as RequestDetail), thread } : base;
  return json(detail);
});

export const PATCH = authedRoute<P>('PATCH /api/requests/[id]', {}, async ({ request, params, session, eventId, event }) => {
  const id = idParam(params);
  const body = await readJson(request, updateRequestSchema);
  const data = await withReclassify(eventId, id, { fn: 'update', expectedVersion: body.expectedVersion }, () =>
    rpc<{ changed?: unknown; row?: unknown }>('lp_update_fields', {
      p_event: eventId,
      p_id: id,
      p_patch: patchPayload(body.patch),
      p_expected_version: body.expectedVersion,
      p_staff: session.staff,
    }),
  );
  const out: ChangeResponse = { changed: data.changed === true, request: mapRow(data.row, postNames(event)) };
  if (out.changed) {
    const status = out.request.status;
    await notifyLater(eventId, () => involvedStaff(eventId, id), () => editEventFor(id, session.staff, status));
  }
  return json(out);
});
