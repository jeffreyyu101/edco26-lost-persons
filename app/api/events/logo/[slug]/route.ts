// (Events) GET /api/events/logo/:slug: the event's logo (sign-in through a join link shows it before any session, so
// no session is needed). A 302 to a 120 s signed URL of the private event-logos bucket; 404 without a logo.
import { ApiFailure } from '@/lib/server/errors';
import { LOGO_BUCKET, loadEventBySlug } from '@/lib/server/events';
import { publicRoute } from '@/lib/server/route';
import { db } from '@/lib/server/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = publicRoute<{ slug: string }>('GET /api/events/logo/[slug]', { refresh: false }, async ({ params }) => {
  const slug = typeof params.slug === 'string' ? params.slug.toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(slug)) throw new ApiFailure('not_found');
  const event = await loadEventBySlug(slug);
  if (!event?.logoPath) throw new ApiFailure('not_found');
  let signed: { data: { signedUrl: string } | null; error: unknown };
  try {
    signed = await db().storage.from(LOGO_BUCKET).createSignedUrl(event.logoPath, 120);
  } catch {
    throw new ApiFailure('unavailable', undefined, { dbCode: 'storage_fetch' });
  }
  if (signed.error || !signed.data?.signedUrl) throw new ApiFailure('not_found', undefined, { dbCode: 'storage_error' });
  return new Response(null, { status: 302, headers: { Location: signed.data.signedUrl, 'Cache-Control': 'public, max-age=60' } });
});
