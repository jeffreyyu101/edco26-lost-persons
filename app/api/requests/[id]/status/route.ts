// POST /api/requests/:id/status (lp_set_status). Idempotent repeat → 200 {changed: false}; stale
// expectedVersion → 409 (currentStatus); illegal transition → 422; Cancelled → Waiting by a non-creator → 403.
// A real change tells everyone involved in the request (Activity + Web Push, F4 spec §18 A57), after the
// response: In medical (with where medical has them), Back to Waiting for check, Reunited, Discharged.
// Not in medical is never notified from here: the Not found yet hold (F5) owns both of its answers.
import { statusChangeEvent } from '@/lib/activity';
import type { ChangeResponse } from '@/lib/api-types';
import { idParam, json, readJson } from '@/lib/server/http';
import { involvedStaff } from '@/lib/server/involved';
import { mapRow } from '@/lib/server/mappers';
import { notifyLater } from '@/lib/server/notify';
import { withReclassify } from '@/lib/server/reclassify';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
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
  const event = out.changed ? statusChangeEvent(out.request.status, out.request.medicalLocation ?? null) : null;
  if (event) await notifyLater(() => involvedStaff(id), () => ({ requestId: id, actor: session.staff, ...event }));
  return json(out);
});
