// Photo upload helpers (spec §6 POST /api/requests/:id/photos, A44). Pure; server only.
import 'server-only';
import { createHash } from 'node:crypto';

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

/** The image type from the file's magic bytes (never the client's Content-Type), or null. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const b = (i: number) => bytes[i];
  if (bytes.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 &&
    b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && // RIFF
    b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50 // WEBP
  ) {
    return 'image/webp';
  }
  return null;
}

/** SHA-256 of the bytes, lowercase hex (64 characters). */
export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Content-addressed object paths (spec §6, A44): {patientId}/{photoId}-{sha256}.jpg and
 * {patientId}/{photoId}-{sha256}_thumb.jpg, each hashed over its own bytes. A path names exactly one
 * content, so stored photos are immutable:
 *   * a retry of the same upload (same photoId, same bytes) finds its own objects, and
 *   * different bytes never land on an object that is already stored or recorded, even when uploads race.
 *     Storage's upsert: false alone does not stop that: concurrent writers of one path all succeed and the
 *     last one wins.
 * The extension is fixed and the stored Content-Type is the sniffed one. Paths stay under 200 characters,
 * which lp_add_photo checks.
 */
export function photoPaths(patientId: string, photoId: string, photo: Uint8Array, thumb: Uint8Array | null): { full: string; thumb: string | null } {
  return {
    full: `${patientId}/${photoId}-${contentHash(photo)}.jpg`,
    thumb: thumb ? `${patientId}/${photoId}-${contentHash(thumb)}_thumb.jpg` : null,
  };
}

/** The parts of a supabase-js StorageError that classify it. */
export interface StorageErrorLike {
  status?: number;
  statusCode?: string | number;
}

/**
 * True when an upload with upsert: false was refused because the object already exists (A44). Storage
 * answers HTTP 409, or HTTP 400 with statusCode "409" in the body (what supabase-js surfaces as
 * StorageApiError.statusCode).
 */
export function isObjectAlreadyExists(error: StorageErrorLike | null | undefined): boolean {
  if (!error) return false;
  return error.status === 409 || String(error.statusCode ?? '') === '409';
}

/** Signed photo URLs live this long (spec §6). */
export const SIGNED_URL_SECONDS = 120;
