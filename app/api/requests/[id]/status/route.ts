// POST /api/requests/:id/status (lp_set_status). Idempotent repeat → 200 {changed: false}; stale
// expectedVersion → 409 (currentStatus); illegal transition → 422; Cancelled → Waiting by a non-creator → 403.
// A real change tells everyone involved in the request (Activity + Web Push, F4 spec §22 A86), after the
// response: In medical (with where medical has them), Back to Waiting for check, Reunited, Discharged,
// Cancelled. Not found is never F4's: both of its answers (the "Not found yet" hold, which keeps the status
// Waiting for check, and the final one) are F5's not_in_medical (lib/server/stage-notify.ts), sent once.
import { after } from 'next/server';
import { statusChangeEvent } from '@/lib/activity';
import type { ChangeResponse } from '@/lib/api-types';
import { idParam, json, readJson } from '@/lib/server/http';
import { involvedStaff } from '@/lib/server/involved';
import { mapRow } from '@/lib/server/mappers';
import { notifyLater } from '@/lib/server/notify';
import { withReclassify } from '@/lib/server/reclassify';
import { authedRoute } from '@/lib/server/route';
import { notifyNotFound } from '@/lib/server/stage-notify';
import { rpc } from '@/lib/server/supabase';
import { STATUS } from '@/lib/domain';
import { setStatusSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute<{ id: string }>('POST /api/requests/[id]/status', {}, async ({ request, params, session }) => {
  const id = idParam(params);
  const body = await readJson(request, setStatusSchema);
  const data = await withReclassify(id, { fn: 'status', expectedVersion: body.expectedVersion, target: body.status }, () =>
    rpc<{ changed?: unknown; row?: unknown }>('lp_set_status', {
      p_id: id,
      p_expected_version: body.expectedVersion,
      p_status: body.status,
      p_staff: session.staff,
      p_kind: body.kind,
    }),
  );
  const out: ChangeResponse = { changed: data.changed === true, request: mapRow(data.row) };
  // (F5) Not found tells everyone involved: the first answer (the "Not found yet" hold: the row comes back
  // still Waiting for check) and the final one. Decided by the target asked for, not the row's status. After
  // the response (next/server `after`), so it never holds the answer up.
  if (out.changed && body.status === STATUS.notInMedical) {
    const row = out.request;
    after(() => notifyNotFound(row, session.staff));
  } else if (out.changed) {
    // (F4) Every other real change. Decided by the target too: a hold's row is still Waiting for check, which
    // must never read as "Back to Waiting for check".
    const event = statusChangeEvent(out.request.status, out.request.medicalLocation ?? null, { place: out.request.swapPlace, post: out.request.postShort });
    if (event) await notifyLater(() => involvedStaff(id), () => ({ requestId: id, actor: session.staff, ...event }));
  }
  return json(out);
});
