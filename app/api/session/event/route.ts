// (Events) POST /api/session/event {eventId}: a lead opens an event (any stage) and gets a re-issued cookie with that
// eventId: from then on every event route works on it, with every staff ability plus setup. {eventId: null} goes back
// to no event open (the Events list). Leads only. Answers the new SessionInfo.
import { ApiFailure } from '@/lib/server/errors';
import { serverEnv } from '@/lib/server/env';
import { loadEvent, sessionBody } from '@/lib/server/events';
import { json, readJson } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { sessionCookie } from '@/lib/server/session';
import { signSessionToken } from '@/lib/server/session-token';
import { openEventSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute('POST /api/session/event', { lead: true, event: 'optional', refresh: false }, async ({ request, session }) => {
  const { eventId } = await readJson(request, openEventSchema);
  const row = eventId ? await loadEvent(eventId.toLowerCase()) : null;
  if (eventId && !row) throw new ApiFailure('not_found');
  const signed = await signSessionToken(
    { staffName: session.claims.staffName, team: session.claims.team, eventId: row?.id ?? null, role: 'lead', pv: session.claims.pv, sid: session.claims.sid },
    serverEnv().sessionSecret,
  );
  if (!signed) throw new ApiFailure('unauthorized');
  return json(await sessionBody(signed.claims, row), 200, { 'Set-Cookie': sessionCookie(request, signed.token, signed.claims.exp) });
});
