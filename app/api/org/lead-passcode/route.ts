// (Events) POST /api/org/lead-passcode {passcode}: changes the Ground Control lead passcode (one for every event).
// Refused (422, field passcode) when it equals any event's staff password. Leads only.
// The change moves lp_org.lead_passcode_version, which signs every lead session out (lib/server/route.ts); the lead
// who made the change gets a re-issued cookie with the new version and stays signed in.
import { serverEnv } from '@/lib/server/env';
import { assertSecretUnique, hashSecret } from '@/lib/server/events';
import { json, readJson } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { clearedSessionCookie, sessionCookie } from '@/lib/server/session';
import { signSessionToken } from '@/lib/server/session-token';
import { rpc } from '@/lib/server/supabase';
import { leadPasscodeSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = authedRoute('POST /api/org/lead-passcode', { lead: true, event: 'optional', refresh: false }, async ({ request, session }) => {
  const { passcode } = await readJson(request, leadPasscodeSchema);
  await assertSecretUnique(passcode, { kind: 'lead' });
  const version = Number(await rpc<number>('lp_org_set_lead_passcode', { p_hash: await hashSecret(passcode) }));
  const signed = await signSessionToken(
    { staffName: session.claims.staffName, team: session.claims.team, eventId: session.claims.eventId, role: 'lead', pv: version, sid: session.claims.sid },
    serverEnv().sessionSecret,
  );
  // At the 36 h cap no new cookie can be issued: the passcode is changed and this session ends like the others.
  if (!signed) return json({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie(request) });
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, signed.token, signed.claims.exp) });
});
