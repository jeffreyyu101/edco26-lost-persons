// (Events) GET /api/events/logo/:slug: the event's logo (sign-in through a join link shows it before any session, so
// no session is needed). Served from this origin (the bytes of the private event-logos object), not a redirect to a
// signed storage URL: the client reads the logo's pixels to tell a single-colour transparent logo (tinted white, the
// rainbow hover) from any other (shown as uploaded), and masks the rainbow with it, which a cross-origin image would
// not allow. The URL carries ?v=<object id> (lib/server/events.ts logoUrl), so a changed logo is a new URL and the
// answer may be cached. 404 without a logo.
import { ApiFailure } from '@/lib/server/errors';
import { LOGO_BUCKET, loadEventBySlug } from '@/lib/server/events';
import { publicRoute } from '@/lib/server/route';
import { db } from '@/lib/server/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPES: Readonly<Record<string, string>> = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

export const GET = publicRoute<{ slug: string }>('GET /api/events/logo/[slug]', { refresh: false }, async ({ params }) => {
  const slug = typeof params.slug === 'string' ? params.slug.toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(slug)) throw new ApiFailure('not_found');
  const event = await loadEventBySlug(slug);
  if (!event?.logoPath) throw new ApiFailure('not_found');
  let file: { data: Blob | null; error: unknown };
  try {
    file = await db().storage.from(LOGO_BUCKET).download(event.logoPath);
  } catch {
    throw new ApiFailure('unavailable', undefined, { dbCode: 'storage_fetch' });
  }
  if (file.error || !file.data) throw new ApiFailure('not_found', undefined, { dbCode: 'storage_error' });
  const ext = event.logoPath.split('.').pop()?.toLowerCase() ?? '';
  const type = TYPES[ext] ?? (file.data.type || 'application/octet-stream');
  return new Response(await file.data.arrayBuffer(), {
    status: 200,
    headers: {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
});
