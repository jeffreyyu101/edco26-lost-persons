// (Events) POST /api/events/:id/go-live: practice → live. Every practice request is deleted (rows, audit trail,
// messages, en route, Activity, read markers, photo rows) in one transaction, numbering restarts at LP-0001, then
// the practice photos' objects are removed from storage (best effort: an orphaned object is never referenced).
// 409 when the event is not in practice. Leads only.
import { eventAdmin, type EventRow } from '@/lib/server/events';
import { idParam, json } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { PHOTO_BUCKET, db, rpc } from '@/lib/server/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute<{ id: string }>('POST /api/events/[id]/go-live', { lead: true, event: 'optional' }, async ({ params }) => {
  const out = await rpc<{ event: EventRow; photoPaths: string[]; deleted: number }>('lp_event_go_live', { p_event: idParam(params) });
  const paths = Array.isArray(out.photoPaths) ? out.photoPaths.filter((p): p is string => typeof p === 'string') : [];
  let removed = 0;
  for (let i = 0; i < paths.length; i += 100) {
    try {
      const { data } = await db().storage.from(PHOTO_BUCKET).remove(paths.slice(i, i + 100));
      removed += Array.isArray(data) ? data.length : 0;
    } catch {
      // best effort
    }
  }
  if (removed < paths.length) console.warn(JSON.stringify({ lp: 'go_live', code: 'photo_objects_left', n: paths.length - removed }));
  return json({ event: eventAdmin(out.event), deleted: Number(out.deleted) || 0 });
});
