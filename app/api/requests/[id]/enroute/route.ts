// POST /api/requests/:id/enroute (lp_set_enroute): front of house walking the friend over.
//   {action: 'set', etaMinutes: 0 | 5 | 10 | 15 | null, queuedMs?}  en route, or a new ETA (Change)
//   {action: 'set', etaAt}                                          the exact ETA back (Undo of a cancel)
//   {action: 'cancel'}                                              clears only the caller's
//   {action: 'arrive'}                                              the friend arrived
// Only while In medical: at any other status it is accepted and changes nothing ({changed: false,
// ignored: true}), so a queued tap that lands late never fails. Repeats change nothing. A change tells
// everyone involved (contract D: enroute / enroute_changed / enroute_cancelled / arrived), after the response.
import type { ActivityResponse } from '@/lib/api-types';
import { idParam, json, readJson } from '@/lib/server/http';
import { enrouteEvent, mapActivity, notifyInvolved, recipientsOf } from '@/lib/server/messages';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { enrouteSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute<{ id: string }>('POST /api/requests/[id]/enroute', {}, async ({ request, params, session }) => {
  const id = idParam(params);
  const body = await readJson(request, enrouteSchema);
  const minutes = body.action === 'set' ? (body.etaMinutes ?? null) : null;
  const queuedSeconds = Math.floor((body.queuedMs ?? 0) / 1000);
  const offset = minutes === null || body.etaAt ? null : Math.max(0, minutes * 60 - queuedSeconds);
  const data = await rpc<{ changed?: unknown; ignored?: unknown; event?: unknown; activity?: unknown; recipients?: unknown }>('lp_set_enroute', {
    p_request: id,
    p_action: body.action,
    p_eta_offset_seconds: offset,
    p_eta_at: body.action === 'set' ? (body.etaAt ?? null) : null,
    p_eta_minutes: minutes,
    p_staff: session.staff,
  });
  const out: ActivityResponse = { changed: data.changed === true, activity: mapActivity(data.activity), ...(data.ignored === true ? { ignored: true } : {}) };
  if (out.changed) {
    const event = enrouteEvent(id, session.staff, data.event, out.activity.enroute);
    if (event) await notifyInvolved(recipientsOf(data.recipients), event);
  }
  return json(out);
});
