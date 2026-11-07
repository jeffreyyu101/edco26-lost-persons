// POST /api/session (sign in with the event password or the team join link, J1), GET /api/session (who am
// I), DELETE /api/session (sign out). Spec §6, A27.
import { serverEnv } from '@/lib/server/env';
import { ApiFailure, mapDbError } from '@/lib/server/errors';
import { clientIp, json, readJson } from '@/lib/server/http';
import { verifyInvite } from '@/lib/server/invite';
import { logRequest, logSignIn } from '@/lib/server/log';
import { verifyPassword } from '@/lib/server/password';
import { authedRoute, publicRoute } from '@/lib/server/route';
import { clearedSessionCookie, sessionCookie, sessionInfo } from '@/lib/server/session';
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

export const POST = publicRoute('POST /api/session', { sameOrigin: true }, async ({ request }) => {
  const body = await readJson(request, signInSchema);
  const ip = clientIp(request.headers);
  const nameKey = body.staffName.toLowerCase();

  // Rate limit first (P0429 → 429 with Retry-After); records a pending attempt that counts as failed
  // until it is finished. The team join link (J1) goes through the same limit: a wrong, expired or
  // switched-off code is a failed attempt, exactly like a wrong password.
  const attemptId = await rpc<number>('lp_login_begin', { p_ip: ip, p_name_key: nameKey }, 'login');
  const method = 'invite' in body ? 'invite' : 'password';
  const ok = 'invite' in body ? verifyInvite(body.invite) : await verifyPassword(body.password);
  await finishAttempt(Number(attemptId), ok);
  logSignIn(method, ok);
  if (!ok) {
    throw method === 'invite'
      ? new ApiFailure('unauthorized', 'Team link not accepted', { extra: { field: 'invite' } })
      : new ApiFailure('unauthorized', 'Incorrect password', { extra: { field: 'password' } });
  }

  const signed = await signSessionToken({ staffName: body.staffName, team: body.team }, serverEnv().sessionSecret);
  if (!signed) throw new ApiFailure('unavailable', undefined, { dbCode: 'sign' });
  return json(sessionInfo(signed.claims), 200, { 'Set-Cookie': sessionCookie(request, signed.token, signed.claims.exp) });
});

export const GET = authedRoute('GET /api/session', {}, async ({ session }) => json(sessionInfo(session.claims)));

export const DELETE = authedRoute('DELETE /api/session', { sameOrigin: true, refresh: false }, async ({ request }) =>
  json({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie(request) }),
);
