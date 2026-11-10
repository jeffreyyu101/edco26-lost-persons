// POST /api/session (sign in with a password or a team join link, J1), GET /api/session (who am I, and the event
// config the client renders from), DELETE /api/session (sign out). Spec §6, A27; Events ("Server").
//
// (Events) A password is checked against the Ground Control lead passcode first (→ role lead, no event open), then
// against each running event's staff password (live and practice → staff of that event). A join link "<slug>.<code>"
// opens its event the same way. (Phase 3) An ended event keeps neither (lp_event_end clears both): its old password is
// a wrong password, and its old join link answers 410 event_ended with what the Ended screen shows, found by the
// link's slug. Every attempt goes through the same rate limit as before; an Ended answer from a slug alone verified
// no credential, so it counts as a failed attempt (it never resets the counter).
import { serverEnv } from '@/lib/server/env';
import { ApiFailure, mapDbError } from '@/lib/server/errors';
import { eventEndedFailure, eventTeamLabel, isEventTeam, loadEvent, matchEndedSlug, matchInvite, matchPassword, sessionBody, type EventRow } from '@/lib/server/events';
import { clientIp, json, readJson } from '@/lib/server/http';
import { logRequest, logSignIn } from '@/lib/server/log';
import { authedRoute, publicRoute } from '@/lib/server/route';
import { clearedSessionCookie, sessionCookie } from '@/lib/server/session';
import { signSessionToken } from '@/lib/server/session-token';
import { db, rpc } from '@/lib/server/supabase';
import { signInSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Records the outcome of an attempt. A failure here never changes the answer (a pending row counts as failed). */
async function finishAttempt(attemptId: number, ok: boolean): Promise<void> {
  const started = performance.now();
  try {
    const { error } = await db().rpc('lp_login_finish', { p_id: attemptId, p_ok: ok });
    if (!error) return;
    const failure = mapDbError(error);
    logRequest({ route: 'POST /api/session finish', status: failure.status, code: failure.code, errorId: failure.errorId, dbCode: failure.dbCode, ms: performance.now() - started });
  } catch {
    logRequest({ route: 'POST /api/session finish', status: 503, code: 'unavailable', dbCode: 'fetch', ms: performance.now() - started });
  }
}

type Resolved = { role: 'lead'; pv: number } | { role: 'staff'; event: EventRow } | { role: 'ended'; event: EventRow | null; verified: boolean } | null;

async function resolve(credential: { password: string } | { invite: string }): Promise<Resolved> {
  let eventId: string | null = null;
  if ('invite' in credential) {
    eventId = (await matchInvite(credential.invite))?.eventId ?? null;
    if (!eventId) {
      const ended = await matchEndedSlug(credential.invite);
      if (ended) return { role: 'ended', event: ended, verified: false };
    }
  } else {
    const match = await matchPassword(credential.password);
    if (match?.kind === 'lead') return { role: 'lead', pv: match.version };
    eventId = match?.eventId ?? null;
  }
  if (!eventId) return null;
  const event = await loadEvent(eventId);
  if (!event) return null;
  return event.stage === 'archived' ? { role: 'ended', event, verified: true } : { role: 'staff', event };
}

export const POST = publicRoute('POST /api/session', { sameOrigin: true }, async ({ request }) => {
  const body = await readJson(request, signInSchema);
  const ip = clientIp(request.headers);
  const nameKey = body.staffName.toLowerCase();

  // Rate limit first (P0429 → 429 with Retry-After); records a pending attempt that counts as failed until it is
  // finished. A wrong, expired or switched-off join code is a failed attempt, exactly like a wrong password.
  const attemptId = await rpc<number>('lp_login_begin', { p_ip: ip, p_name_key: nameKey }, 'login');
  const method = 'invite' in body ? 'invite' : 'password';
  let resolved: Resolved = null;
  try {
    resolved = await resolve('invite' in body ? { invite: body.invite } : { password: body.password });
  } finally {
    await finishAttempt(Number(attemptId), resolved !== null && !(resolved.role === 'ended' && !resolved.verified));
  }
  logSignIn(method, resolved !== null);
  if (!resolved) {
    throw method === 'invite'
      ? new ApiFailure('unauthorized', 'Team link not accepted', { extra: { field: 'invite' } })
      : new ApiFailure('unauthorized', 'Incorrect password', { extra: { field: 'password' } });
  }
  if (resolved.role === 'ended') throw eventEndedFailure(resolved.event);

  // A staff member's team: one of the event's teams (spelled as the event spells it), or any "Other" text.
  const team = resolved.role === 'staff' && isEventTeam(resolved.event, body.team) ? eventTeamLabel(resolved.event, body.team) : body.team;
  const eventId = resolved.role === 'staff' ? resolved.event.id : null;
  const pv = resolved.role === 'lead' ? resolved.pv : null;
  const signed = await signSessionToken({ staffName: body.staffName, team, eventId, role: resolved.role, pv }, serverEnv().sessionSecret);
  if (!signed) throw new ApiFailure('unavailable', undefined, { dbCode: 'sign' });
  const info = await sessionBody(signed.claims, resolved.role === 'staff' ? resolved.event : null);
  return json(info, 200, { 'Set-Cookie': sessionCookie(request, signed.token, signed.claims.exp) });
});

// (Events) A staff session of an ended event gets 410 event_ended with the event block from the route wrapper (the
// Ended screen), not a bare 401; signing out stays possible after the end.
export const GET = authedRoute('GET /api/session', { event: 'optional' }, async ({ session, event }) => json(await sessionBody(session.claims, event)));

export const DELETE = authedRoute('DELETE /api/session', { sameOrigin: true, refresh: false, event: 'optional', afterEnd: true }, async ({ request }) =>
  json({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie(request) }),
);
