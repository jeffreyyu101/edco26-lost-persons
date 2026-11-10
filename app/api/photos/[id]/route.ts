// GET /api/photos/:id?size=thumb|full (spec §6): a session is required; the active photo's object is served
// through a 302 to a 120 s signed URL (the bucket stays private). size=thumb falls back to the full image
// for legacy photos without a thumbnail. The redirect may be reused for 60 s by this browser only.
import { ApiFailure, mapDbError } from '@/lib/server/errors';
import { idParam, parseQuery } from '@/lib/server/http';
import { SIGNED_URL_SECONDS } from '@/lib/server/photos';
import { authedRoute } from '@/lib/server/route';
import { PHOTO_BUCKET, db } from '@/lib/server/supabase';
import { photoQuerySchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authedRoute<{ id: string }>('GET /api/photos/[id]', { refresh: false }, async ({ request, params, eventId }) => {
  const id = idParam(params);
  const { size } = parseQuery(new URL(request.url).searchParams, photoQuerySchema);

  let found: { data: { storage_path: string | null; thumb_path: string | null } | null; error: unknown };
  try {
    found = await db()
      .from('patient_photos')
      // (Events) Only a photo of a request in the session's event (the inner join filters the rest out → 404).
      .select('storage_path, thumb_path, patients!inner(event_id)')
      .eq('id', id)
      .eq('is_active', true)
      .eq('patients.event_id', eventId)
      .maybeSingle();
  } catch {
    throw new ApiFailure('unavailable', undefined, { dbCode: 'fetch' });
  }
  if (found.error) throw mapDbError(found.error as { code?: string });
  const path = size === 'thumb' ? (found.data?.thumb_path ?? found.data?.storage_path) : found.data?.storage_path;
  if (!path) throw new ApiFailure('not_found');

  let signed: { data: { signedUrl: string } | null; error: { statusCode?: string; status?: number } | null };
  try {
    signed = await db().storage.from(PHOTO_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  } catch {
    throw new ApiFailure('unavailable', undefined, { dbCode: 'storage_fetch' });
  }
  if (signed.error || !signed.data?.signedUrl) {
    const status = String(signed.error?.statusCode ?? signed.error?.status ?? '');
    if (status === '404') throw new ApiFailure('not_found', undefined, { dbCode: 'storage_404' });
    throw new ApiFailure('unavailable', undefined, { dbCode: `storage_${status || 'error'}` });
  }

  return new Response(null, {
    status: 302,
    headers: { Location: signed.data.signedUrl, 'Cache-Control': 'private, max-age=60' },
  });
});
