// (Events) POST /api/events/:id/logo (multipart, field `logo`: PNG, WebP or JPEG, ≤ 1 MB, sniffed from its bytes):
// stores the event's logo in the private event-logos bucket and removes the previous one. DELETE removes it.
// Leads only. The logo is served by GET /api/events/logo/<slug>.
import { randomUUID } from 'node:crypto';
import { ApiFailure } from '@/lib/server/errors';
import { LOGO_BUCKET, LOGO_MAX_BYTES, eventAdmin, type EventRow } from '@/lib/server/events';
import { idParam, json, readBodyLimited } from '@/lib/server/http';
import { sniffImage } from '@/lib/server/photos';
import { authedRoute } from '@/lib/server/route';
import { db, rpc } from '@/lib/server/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = { id: string };

const EXT = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' } as const;

async function removeLogo(path: string | null | undefined): Promise<void> {
  if (!path) return;
  try {
    await db().storage.from(LOGO_BUCKET).remove([path]);
  } catch {
    // Best effort: an orphaned logo object is never referenced again.
  }
}

export const POST = authedRoute<P>('POST /api/events/[id]/logo', { lead: true, event: 'optional' }, async ({ request, params }) => {
  const id = idParam(params);
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new ApiFailure('unsupported_media', 'Send the logo as multipart/form-data');
  const body = await readBodyLimited(request, LOGO_MAX_BYTES + 64 * 1024);
  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new ApiFailure('bad_request', 'Could not read the upload');
  }
  const file = form.get('logo');
  if (!file || typeof file === 'string') throw new ApiFailure('invalid', 'Choose a logo', { extra: { field: 'logo' } });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > LOGO_MAX_BYTES) throw new ApiFailure('too_large', 'Logo: at most 1 MB', { extra: { field: 'logo' } });
  const type = sniffImage(bytes);
  if (!type) throw new ApiFailure('unsupported_media', 'Use a PNG, WebP or JPEG logo', { extra: { field: 'logo' } });

  const path = `${id}/${randomUUID()}.${EXT[type]}`;
  let uploadError: unknown = null;
  try {
    ({ error: uploadError } = await db().storage.from(LOGO_BUCKET).upload(path, bytes, { contentType: type, upsert: false }));
  } catch {
    throw new ApiFailure('unavailable', undefined, { dbCode: 'storage_fetch' });
  }
  if (uploadError) throw new ApiFailure('unavailable', undefined, { dbCode: 'storage_error' });
  let out: { event: EventRow; oldPath: string | null };
  try {
    out = await rpc<{ event: EventRow; oldPath: string | null }>('lp_event_set_logo', { p_event: id, p_path: path });
  } catch (error) {
    await removeLogo(path);
    throw error;
  }
  await removeLogo(out.oldPath);
  return json({ event: eventAdmin(out.event) });
});

export const DELETE = authedRoute<P>('DELETE /api/events/[id]/logo', { lead: true, event: 'optional' }, async ({ params }) => {
  const out = await rpc<{ event: EventRow; oldPath: string | null }>('lp_event_set_logo', { p_event: idParam(params), p_path: null });
  await removeLogo(out.oldPath);
  return json({ event: eventAdmin(out.event) });
});
