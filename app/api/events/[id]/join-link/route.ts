// (Events) POST /api/events/:id/join-link {expiresAt?}: a new join link for the event (the old one stops working).
// Answers the link once, {link, expiresAt, event}: only the code's SHA-256 is stored, so it can never be shown again.
// The link is https://<host>/signin#join=<slug>.<code>. Default expiry: two days after the last show day.
// DELETE turns the join link off. Leads only.
import { ApiFailure } from '@/lib/server/errors';
import { eventAdmin, joinToken, newJoinCode, requireEvent, sha256Hex, type EventRow } from '@/lib/server/events';
import { idParam, json, readJson } from '@/lib/server/http';
import { authedRoute } from '@/lib/server/route';
import { rpc } from '@/lib/server/supabase';
import { joinLinkSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = { id: string };

const DAY_MS = 24 * 60 * 60 * 1000;

export const POST = authedRoute<P>('POST /api/events/[id]/join-link', { lead: true, event: 'optional' }, async ({ request, params }) => {
  const id = idParam(params);
  const body = await readJson(request, joinLinkSchema);
  const event = await requireEvent(id);
  const expiresMs = body.expiresAt ? Date.parse(body.expiresAt) : Date.parse(`${event.endsOn}T00:00:00Z`) + 3 * DAY_MS;
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now() || expiresMs > Date.now() + 90 * DAY_MS) {
    throw new ApiFailure('invalid', 'Pick an expiry within 90 days', { extra: { field: 'expiresAt' } });
  }
  const code = newJoinCode();
  const expiresAt = new Date(expiresMs).toISOString();
  const row = await rpc<EventRow>('lp_event_set_invite', { p_event: id, p_sha256: sha256Hex(code), p_expires_at: expiresAt });
  const link = `${new URL(request.url).origin}/signin#join=${joinToken(row.slug, code)}`;
  return json({ link, expiresAt, event: eventAdmin(row) }, 201);
});

export const DELETE = authedRoute<P>('DELETE /api/events/[id]/join-link', { lead: true, event: 'optional' }, async ({ params }) => {
  const row = await rpc<EventRow>('lp_event_set_invite', { p_event: idParam(params), p_sha256: null, p_expires_at: null });
  return json({ event: eventAdmin(row) });
});
