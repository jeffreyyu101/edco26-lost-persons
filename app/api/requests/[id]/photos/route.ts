// POST /api/requests/:id/photos (spec §6). Multipart: photoId (client UUID), timing (today | older),
// photo and thumb (JPEG / PNG / WebP, sniffed by magic bytes). The whole request must be ≤ 3,900,000
// bytes (Vercel caps bodies at 4.5 MB).
//
// Objects go to the private bucket at stable paths ({id}/{photoId}.jpg, {id}/{photoId}_thumb.jpg) with
// upsert, so a retry with the same photoId is idempotent; then lp_add_photo records them (idempotent on
// photoId, ≤ 3 active photos, bumps the request's rowVersion so the change syncs). The objects are deleted
// ONLY after a definitive rejection (photo limit, invalid, creator-only, no such request). On timeouts and
// unknown errors they are kept and the response is 503, so the client retries with the same photoId.
import type { PhotoResponse } from '@/lib/api-types';
import { PHOTO_UPLOAD_MAX_BYTES } from '@/lib/domain';
import { ApiFailure, isDefinitiveRejection } from '@/lib/server/errors';
import { idParam, invalidFromZod, json, readBodyLimited } from '@/lib/server/http';
import { mapPhoto, mapRow } from '@/lib/server/mappers';
import { photoPaths, sniffImage, type ImageType } from '@/lib/server/photos';
import { authedRoute } from '@/lib/server/route';
import { PHOTO_BUCKET, db, rpc } from '@/lib/server/supabase';
import { photoFieldsSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Upload {
  path: string;
  bytes: Uint8Array;
  type: ImageType;
}

function isFile(value: FormDataEntryValue | null): value is File {
  return typeof value === 'object' && value !== null && typeof (value as Blob).arrayBuffer === 'function';
}

async function readImage(form: FormData, field: 'photo' | 'thumb', required: boolean): Promise<{ bytes: Uint8Array; type: ImageType } | null> {
  const value = form.get(field);
  if (value === null || (!required && value === '')) {
    if (required) throw new ApiFailure('invalid', 'Choose a photo', { extra: { field } });
    return null;
  }
  if (!isFile(value)) throw new ApiFailure('invalid', 'Choose a photo', { extra: { field } });
  const bytes = new Uint8Array(await value.arrayBuffer());
  const type = sniffImage(bytes);
  if (!type) throw new ApiFailure('unsupported_media', 'Use a JPEG, PNG or WebP photo', { extra: { field } });
  return { bytes, type };
}

async function upload(item: Upload): Promise<void> {
  let error: { statusCode?: string; status?: number } | null = null;
  try {
    ({ error } = await db().storage.from(PHOTO_BUCKET).upload(item.path, item.bytes, { contentType: item.type, upsert: true }));
  } catch {
    throw new ApiFailure('unavailable', undefined, { dbCode: 'storage_fetch' });
  }
  if (error) throw new ApiFailure('unavailable', undefined, { dbCode: `storage_${error.statusCode ?? error.status ?? 'error'}` });
}

async function removeObjects(paths: string[]): Promise<void> {
  try {
    await db().storage.from(PHOTO_BUCKET).remove(paths);
  } catch {
    // Best effort: an orphaned object is acceptable (spec §6); it is never referenced by a row.
  }
}

export const POST = authedRoute<{ id: string }>('POST /api/requests/[id]/photos', {}, async ({ request, params, session }) => {
  const id = idParam(params);
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new ApiFailure('unsupported_media', 'Send the photo as multipart/form-data');

  const body = await readBodyLimited(request, PHOTO_UPLOAD_MAX_BYTES);
  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new ApiFailure('bad_request', 'Could not read the upload');
  }

  const fields = photoFieldsSchema.safeParse({ photoId: form.get('photoId'), timing: form.get('timing') });
  if (!fields.success) throw invalidFromZod(fields.error);
  const photoId = fields.data.photoId.toLowerCase();

  const photo = await readImage(form, 'photo', true);
  const thumb = await readImage(form, 'thumb', false);
  if (!photo) throw new ApiFailure('invalid', 'Choose a photo', { extra: { field: 'photo' } });

  const paths = photoPaths(id, photoId);
  const uploads: Upload[] = [{ path: paths.full, ...photo }];
  if (thumb) uploads.push({ path: paths.thumb, ...thumb });
  await Promise.all(uploads.map(upload));

  let data: { created?: unknown; photo?: unknown; row?: unknown };
  try {
    data = await rpc('lp_add_photo', {
      p_id: id,
      p_photo_id: photoId,
      p_path: paths.full,
      p_thumb: thumb ? paths.thumb : null,
      p_timing: fields.data.timing,
      p_staff: session.staff,
    }, 'photo');
  } catch (error) {
    // field:path means the path belongs to another photo row: never delete objects in that case.
    if (error instanceof ApiFailure && isDefinitiveRejection(error) && error.extra.field !== 'path') {
      await removeObjects(uploads.map((u) => u.path));
    }
    throw error;
  }

  const out: PhotoResponse = { created: data.created === true, photo: mapPhoto(data.photo), request: mapRow(data.row) };
  return json(out, out.created ? 201 : 200);
});
