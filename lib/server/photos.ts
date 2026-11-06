// Photo upload helpers (spec §6 POST /api/requests/:id/photos). Pure; server only.
import 'server-only';

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

/**
 * Stable object paths, so a retry with the same photoId overwrites (upsert) instead of duplicating:
 * {patientId}/{photoId}.jpg and {patientId}/{photoId}_thumb.jpg (spec §6; the extension is fixed, the
 * stored Content-Type is the sniffed one).
 */
export function photoPaths(patientId: string, photoId: string): { full: string; thumb: string } {
  return { full: `${patientId}/${photoId}.jpg`, thumb: `${patientId}/${photoId}_thumb.jpg` };
}

/** Signed photo URLs live this long (spec §6). */
export const SIGNED_URL_SECONDS = 120;
