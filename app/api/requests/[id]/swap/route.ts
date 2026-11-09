// (Companion) POST /api/requests/:id/swap (lp_swap): the friend swap on an Accompanied request.
//   {action: 'request'}                  → swap_requested_* set, stays Accompanied. Tells the staff who answered.
//   {action: 'approve', place: 'fa'|'mm'} → In medical (Located · friend coming) with swapPlace. Tells everyone involved.
//   {action: 'decline'}                  → the request cleared, stays Accompanied. Tells the requester and the creator.
//   {action: 'withdraw'}                 → the same, telling nobody (the requester's Undo of Request swap).
//   {action: 'cancel'}                   → swap requested: cleared, stays Accompanied (tells the answerer); swap
//                                          approved: back to Accompanied, swapPlace cleared (tells everyone involved).
// Same conventions as the status route: idempotent repeat → 200 {changed: false}; stale expectedVersion → 409
// (currentStatus); not Accompanied → 422. Returns {changed, request}. Notifications run after the response.
import { swapNotice } from '@/lib/server/notify';
import type { ChangeResponse } from '@/lib/api-types';
import { idParam, json, readJson } from '@/lib/server/http';
import { mapRow } from '@/lib/server/mappers';
import { withReclassify } from '@/lib/server/reclassify';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { swapSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SwapResult {
  changed?: unknown;
  row?: unknown;
  answerer?: unknown;
  requester?: unknown;
  creator?: unknown;
  from?: unknown;
}

export const POST = authedRoute<{ id: string }>('POST /api/requests/[id]/swap', {}, async ({ request, params, session }) => {
  const id = idParam(params);
  const body = await readJson(request, swapSchema);
  const data = await withReclassify(id, { fn: 'swap', expectedVersion: body.expectedVersion }, () =>
    rpc<SwapResult>('lp_swap', {
      p_id: id,
      p_expected_version: body.expectedVersion,
      p_action: body.action,
      p_place: body.action === 'approve' ? body.place : null,
      p_staff: session.staff,
    }),
  );
  const out: ChangeResponse = { changed: data.changed === true, request: mapRow(data.row) };
  if (out.changed) {
    const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
    await swapNotice(body.action, out.request, session.staff, {
      answerer: str(data.answerer),
      requester: str(data.requester),
      creator: str(data.creator),
      from: data.from === 'requested' || data.from === 'approved' ? data.from : null,
    });
  }
  return json(out);
});
