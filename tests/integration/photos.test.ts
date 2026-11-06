// Photos (spec §6): multipart upload with magic-byte sniffing, the 3.9 MB cap, stable object paths and
// upsert, idempotent retries, exactly 3 under concurrency, object cleanup only on definitive rejections,
// the rowVersion bump that makes the photo sync, and the signed-URL redirect (thumb fallback, private bucket).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApiError, PhotoResponse, RequestDetail, SyncResponse } from '@/lib/api-types';
import { syncPath } from '@/lib/client/api-paths';
import { ROOT } from '../../scripts/test-env.mjs';
import { admin, api, cookieFor, createRequest, newStaff, randomUUID, staffOf, withTestServer } from './harness';

withTestServer();

const JPEG = readFileSync(join(ROOT, 'supabase', 'seed-photos', 'photo.jpg'));
const JPEG_THUMB = readFileSync(join(ROOT, 'supabase', 'seed-photos', 'photo_thumb.jpg'));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x40, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(64, 2)]);
const BUCKET = 'patient-photos';

interface UploadParts {
  photoId?: string | null;
  timing?: string | null;
  photo?: Buffer | null;
  thumb?: Buffer | null;
  photoType?: string;
}

function form(parts: UploadParts): FormData {
  const f = new FormData();
  if (parts.photoId !== null) f.set('photoId', parts.photoId ?? randomUUID());
  if (parts.timing !== null) f.set('timing', parts.timing ?? 'today');
  if (parts.photo !== null) f.set('photo', new Blob([new Uint8Array(parts.photo ?? JPEG)], { type: parts.photoType ?? 'image/jpeg' }), 'photo.jpg');
  if (parts.thumb !== null) f.set('thumb', new Blob([new Uint8Array(parts.thumb ?? JPEG_THUMB)], { type: 'image/jpeg' }), 'thumb.jpg');
  return f;
}

async function upload(cookie: string, requestId: string, parts: UploadParts = {}, origin?: string | null) {
  return api<PhotoResponse & ApiError>(`/api/requests/${requestId}/photos`, { method: 'POST', body: form(parts), cookie, origin });
}

async function objectsUnder(requestId: string): Promise<string[]> {
  const { data, error } = await admin().storage.from(BUCKET).list(requestId, { limit: 100 });
  if (error) throw new Error(`list failed: ${error.message}`);
  return (data ?? []).map((o) => o.name).sort();
}

async function activePhotoRows(requestId: string): Promise<number> {
  const { data, error } = await admin().from('patient_photos').select('id').eq('patient_id', requestId).eq('is_active', true);
  if (error) throw new Error(error.code);
  return data.length;
}

describe('POST /api/requests/:id/photos', () => {
  it('uploads to the stable paths, records the photo and returns {created, photo, request} (201)', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const r = await createRequest(staff);
    const photoId = randomUUID();
    const res = await upload(cookie, r.id, { photoId, timing: 'older' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.created).toBe(true);
    expect(res.body.photo).toMatchObject({ id: photoId, timing: 'older', uploadedBy: staffOf(staff), hasThumb: true });
    expect(res.body.request).toMatchObject({ id: r.id, photoCount: 1, firstPhotoId: photoId, rowVersion: r.rowVersion + 1 });
    expect(await objectsUnder(r.id)).toEqual([`${photoId}.jpg`, `${photoId}_thumb.jpg`]);

    const detail = (await api(`/api/requests/${r.id}`, { cookie })).body as RequestDetail;
    expect(detail.photos).toHaveLength(1);
    expect(detail.audit.map((e) => e.action)).toEqual(['created', 'photo']);
    expect(detail.audit[1]).toMatchObject({ next: { photoId, timing: 'older' } });
  });

  it('PNG and WebP are accepted (sniffed type), and the thumb is optional', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const r = await createRequest(staff);
    const png = await upload(cookie, r.id, { photo: PNG, photoType: 'image/png', thumb: null });
    expect(png.status, JSON.stringify(png.body)).toBe(201);
    expect(png.body.photo.hasThumb).toBe(false);
    const webp = await upload(cookie, r.id, { photo: WEBP, photoType: 'application/octet-stream', thumb: WEBP });
    expect(webp.status, JSON.stringify(webp.body)).toBe(201);
  });

  it('a retry with the same photoId → 200 {created: false}, still one row', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const r = await createRequest(staff);
    const photoId = randomUUID();
    expect((await upload(cookie, r.id, { photoId })).status).toBe(201);
    const retry = await upload(cookie, r.id, { photoId });
    expect(retry.status).toBe(200);
    expect(retry.body.created).toBe(false);
    expect(retry.body.photo.id).toBe(photoId);
    expect(await activePhotoRows(r.id)).toBe(1);
    expect(await objectsUnder(r.id)).toHaveLength(2);
  });

  it('the 4th photo → 422 photo_limit, and its objects are deleted', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const r = await createRequest(staff);
    for (let i = 0; i < 3; i += 1) expect((await upload(cookie, r.id)).status).toBe(201);
    const fourthId = randomUUID();
    const fourth = await upload(cookie, r.id, { photoId: fourthId });
    expect(fourth.status).toBe(422);
    expect(fourth.body).toMatchObject({ error: { code: 'photo_limit' } });
    expect(await activePhotoRows(r.id)).toBe(3);
    const objects = await objectsUnder(r.id);
    expect(objects).toHaveLength(6);
    expect(objects.some((o) => o.startsWith(fourthId))).toBe(false);
    // A retry of an accepted photo still succeeds at the limit (idempotent).
  });

  it('4 concurrent uploads → exactly 3 succeed', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const r = await createRequest(staff);
    const results = await Promise.all(Array.from({ length: 4 }, () => upload(cookie, r.id)));
    const statuses = results.map((x) => x.status).sort();
    expect(statuses).toEqual([201, 201, 201, 422]);
    expect(await activePhotoRows(r.id)).toBe(3);
    expect(await objectsUnder(r.id)).toHaveLength(6);
    const { data } = await admin().from('audit_events').select('id').eq('patient_id', r.id).eq('action_type', 'photo_uploaded');
    expect(data).toHaveLength(3);
  });

  it('the upload bumps rowVersion and the request appears in the next delta sync with its photo', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const r = await createRequest(staff);
    const before = (await api<SyncResponse>(syncPath({ ids: [r.id] }), { cookie })).body;
    const res = await upload(cookie, r.id);
    expect(res.status).toBe(201);
    const delta = (await api<SyncResponse>(syncPath({ since: before.serverTime }), { cookie })).body;
    const row = delta.rows.find((x) => x.id === r.id);
    expect(row).toMatchObject({ photoCount: 1, firstPhotoId: res.body.photo.id, rowVersion: r.rowVersion + 1 });
  });

  it('rejects content that is not an image (415), whatever its declared type, and stores nothing', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const r = await createRequest(staff);
    const text = await upload(cookie, r.id, { photo: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), photoType: 'image/jpeg' });
    expect(text.status).toBe(415);
    expect(text.body.error).toMatchObject({ code: 'unsupported_media', field: 'photo' });
    const badThumb = await upload(cookie, r.id, { thumb: Buffer.from('GIF89a......') });
    expect(badThumb.status).toBe(415);
    expect(badThumb.body.error.field).toBe('thumb');
    const empty = await upload(cookie, r.id, { photo: Buffer.alloc(0) });
    expect(empty.status).toBe(415);
    expect(await objectsUnder(r.id)).toEqual([]);
  });

  it('a body over 3,900,000 bytes → 413', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const r = await createRequest(staff);
    const big = Buffer.concat([JPEG.subarray(0, 4), Buffer.alloc(3_900_000)]);
    const res = await upload(cookie, r.id, { photo: big });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('too_large');
    expect(await objectsUnder(r.id)).toEqual([]);
  });

  it('field validation: missing / bad photoId, bad timing, missing photo → 422; not multipart → 415', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const r = await createRequest(staff);
    const cases: Array<[UploadParts, string]> = [
      [{ photoId: null }, 'photoId'],
      [{ photoId: 'nope' }, 'photoId'],
      [{ timing: 'unsure' }, 'timing'],
      [{ timing: null }, 'timing'],
      [{ photo: null }, 'photo'],
    ];
    for (const [parts, field] of cases) {
      const res = await upload(cookie, r.id, parts);
      expect(res.status, JSON.stringify(parts)).toBe(422);
      expect(res.body.error.field).toBe(field);
    }
    const json = await api(`/api/requests/${r.id}/photos`, { json: { photoId: randomUUID(), timing: 'today' }, cookie });
    expect(json.status).toBe(415);
  });

  it('unknown request → 404, and the uploaded objects are removed', async () => {
    const cookie = await cookieFor(newStaff());
    const ghost = randomUUID();
    const res = await upload(cookie, ghost);
    expect(res.status).toBe(404);
    expect(await objectsUnder(ghost)).toEqual([]);
    expect((await upload(cookie, 'not-a-uuid')).status).toBe(404);
  });

  it('a photoId already used by another request → 422, and the other request keeps its object', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const a = await createRequest(staff);
    const b = await createRequest(staff);
    const photoId = randomUUID();
    expect((await upload(cookie, a.id, { photoId })).status).toBe(201);
    const clash = await upload(cookie, b.id, { photoId });
    expect(clash.status).toBe(422);
    expect(clash.body.error.field).toBe('photoId');
    expect(await objectsUnder(a.id)).toHaveLength(2);
    expect(await objectsUnder(b.id)).toEqual([]);
  });

  it('auth required (401) and same-origin required (403)', async () => {
    const staff = newStaff();
    const r = await createRequest(staff);
    expect((await upload('', r.id)).status).toBe(401);
    const foreign = await upload(await cookieFor(staff), r.id, {}, 'https://evil.example');
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('bad_origin');
    expect(await objectsUnder(r.id)).toEqual([]);
  });
});

describe('GET /api/photos/:id', () => {
  it('302 to a short-lived signed URL (private, max-age=60); thumb and full are different objects', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const r = await createRequest(staff);
    const up = await upload(cookie, r.id);
    const id = up.body.photo.id;

    const full = await api(`/api/photos/${id}`, { cookie });
    expect(full.status).toBe(302);
    expect(full.headers.get('cache-control')).toBe('private, max-age=60');
    const fullUrl = full.headers.get('location') as string;
    expect(fullUrl).toContain(`/storage/v1/object/sign/${BUCKET}/${r.id}/${id}.jpg?token=`);
    const fullBytes = Buffer.from(await (await fetch(fullUrl)).arrayBuffer());
    expect(fullBytes.equals(JPEG)).toBe(true);

    const thumb = await api(`/api/photos/${id}?size=thumb`, { cookie });
    expect(thumb.status).toBe(302);
    const thumbUrl = thumb.headers.get('location') as string;
    expect(thumbUrl).toContain(`/${id}_thumb.jpg?token=`);
    expect(Buffer.from(await (await fetch(thumbUrl)).arrayBuffer()).equals(JPEG_THUMB)).toBe(true);
  });

  it('a legacy photo without a thumbnail serves the full image for size=thumb', async () => {
    const cookie = await cookieFor(newStaff());
    const legacy = 'f0f0f0f0-0000-4000-8000-000000010051'; // seed LP-1005, no thumb_path
    const res = await api(`/api/photos/${legacy}?size=thumb`, { cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/0b1e0b1e-0000-4000-8000-000000010051.jpg?token=');
  });

  it('inactive or unknown photo → 404; bad size → 400; non-UUID → 404; auth required', async () => {
    const cookie = await cookieFor(newStaff());
    const inactive = 'f0f0f0f0-0000-4000-8000-000000009962'; // seed LP-0996, is_active = false
    expect((await api(`/api/photos/${inactive}`, { cookie })).status).toBe(404);
    const unknown = await api(`/api/photos/${randomUUID()}`, { cookie });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('cache-control')).toBe('no-store');
    expect((await api('/api/photos/f0f0f0f0-0000-4000-8000-000000010121?size=huge', { cookie })).status).toBe(400);
    expect((await api('/api/photos/nope', { cookie })).status).toBe(404);
    expect((await api('/api/photos/f0f0f0f0-0000-4000-8000-000000010121')).status).toBe(401);
  });

  it('the bucket is private: an unsigned public URL does not serve the object', async () => {
    const path = '5eed0000-0000-4000-8000-000000001012/f0f0f0f0-0000-4000-8000-000000010121.jpg';
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (anonKey) {
      const authed = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      });
      expect(authed.status).toBeGreaterThanOrEqual(400);
    }
  });
});
