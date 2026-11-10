// POST /api/requests/:id/photos (spec §6, A44). Multipart: photoId (client UUID), timing (today | older),
// photo and thumb (JPEG / PNG / WebP, sniffed by magic bytes). The whole request must be ≤ 3,900,000
// bytes (Vercel caps bodies at 4.5 MB).
//
// Stored photos are immutable (A44): an object's bytes never change once written.
//   1. If a photo row with this photoId already exists, answer from it (lp_add_photo: created: false, or
//      photo_id_in_use when it belongs to another request). Storage is not touched.
//   2. Otherwise store the objects in the private bucket at content-addressed paths
//      ({id}/{photoId}-{sha256}.jpg and …_thumb.jpg, lib/server/photos.ts) with upsert: false. An object
//      that already exists at such a path holds these exact bytes (a retry after a failed record or a
//      partial upload), so it is kept and counts as stored. Different bytes always get a different path.
//   3. lp_add_photo records them (≤ 3 active photos, bumps the request's rowVersion so the change syncs,
//      audits photo_uploaded). The objects are deleted ONLY after a definitive rejection (photo limit,
//      invalid, creator-only, no such request). On timeouts and unknown errors they are kept and the
//      response is 503, so the client retries with the same photoId.
import type { PhotoResponse } from '@/lib/api-types';
import { PHOTO_UPLOAD_MAX_BYTES } from '@/lib/domain';
import { ApiFailure, isDefinitiveRejection } from '@/lib/server/errors';
import { idParam, invalidFromZod, json, readBodyLimited } from '@/lib/server/http';
import { mapPhoto, mapRow } from '@/lib/server/mappers';
import { isObjectAlreadyExists, photoPaths, sniffImage, type ImageType, type StorageErrorLike } from '@/lib/server/photos';
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

interface AddPhotoResult {
  created?: unknown;
  photo?: unknown;
  row?: unknown;
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

/** True when a photo row with this id exists (for any request). A failed lookup is a 503 (retry). */
async function photoRowExists(photoId: string): Promise<boolean> {
  let found: { data: { id: string } | null; error: { code?: string } | null };
  try {
    found = await db().from('patient_photos').select('id').eq('id', photoId).maybeSingle();
  } catch {
    throw new ApiFailure('unavailable', undefined, { dbCode: 'fetch' });
  }
  if (found.error) throw new ApiFailure('unavailable', undefined, { dbCode: found.error.code || 'db' });
  return found.data !== null;
}

/**
 * Stores one object without ever replacing an existing one (upsert: false). "Already exists" counts as
 * stored: the path is content-addressed, so the object there holds these exact bytes.
 */
async function store(item: Upload): Promise<void> {
  let error: StorageErrorLike | null = null;
  try {
    ({ error } = await db().storage.from(PHOTO_BUCKET).upload(item.path, item.bytes, { contentType: item.type, upsert: false }));
  } catch {
    throw new ApiFailure('unavailable', undefined, { dbCode: 'storage_fetch' });
  }
  if (error && !isObjectAlreadyExists(error)) {
    throw new ApiFailure('unavailable', undefined, { dbCode: `storage_${error.statusCode ?? error.status ?? 'error'}` });
  }
}

async function removeObjects(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await db().storage.from(PHOTO_BUCKET).remove(paths);
  } catch {
    // Best effort: an orphaned object is acceptable (spec §6); it is never referenced by a row.
  }
}

export const POST = authedRoute<{ id: string }>('POST /api/requests/[id]/photos', {}, async ({ request, params, session, eventId }) => {
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

  const paths = photoPaths(id, photoId, photo.bytes, thumb?.bytes ?? null);
  const uploads: Upload[] = [{ path: paths.full, ...photo }];
  if (thumb && paths.thumb) uploads.push({ path: paths.thumb, ...thumb });

  /** lp_add_photo. `stored` = the objects to delete after a definitive rejection. */
  const record = async (stored: Upload[]): Promise<AddPhotoResult> => {
    try {
      return await rpc<AddPhotoResult>('lp_add_photo', {
        p_event: eventId,
        p_id: id,
        p_photo_id: photoId,
        p_path: paths.full,
        p_thumb: paths.thumb,
        p_timing: fields.data.timing,
        p_staff: session.staff,
      }, 'photo');
    } catch (error) {
      // field:path means the path belongs to another photo row: never delete objects in that case.
      if (error instanceof ApiFailure && isDefinitiveRejection(error) && error.extra.field !== 'path') {
        await removeObjects(stored.map((u) => u.path));
      }
      throw error;
    }
  };

  // (Events) Nothing is stored for an ended event (410) or a request of another event (404): checked before the upload.
  await rpc('lp_require_writable', { p_event: eventId });
  await rpc('lp_require_event_row', { p_event: eventId, p_request: id });

  let data: AddPhotoResult;
  if (await photoRowExists(photoId)) {
    // Already recorded: the idempotent answer. Its objects stay exactly as they are and nothing new is stored.
    data = await record([]);
  } else {
    await Promise.all(uploads.map(store));
    data = await record(uploads);
  }

  const out: PhotoResponse = { created: data.created === true, photo: mapPhoto(data.photo), request: mapRow(data.row) };
  return json(out, out.created ? 201 : 200);
});
