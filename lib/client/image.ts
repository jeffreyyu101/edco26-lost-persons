// Photo compression (spec §7 Photos). Loaded on demand (preparePhoto imports it), so it never weighs on the
// first load of `/`.
//   * Decode through an <img> (object URL + decode()): browsers apply the EXIF orientation there.
//   * Draw straight into a canvas of the TARGET size (never a full-size canvas: iOS caps canvas memory).
//   * Full: ≤ 1600 px long edge, JPEG 0.82; step the quality down to 0.6, then shrink the edge, until ≤ 2.5 MB.
//   * Thumb: ≤ 320 px, JPEG 0.7. Re-encoding strips EXIF (GPS included).
import {
  PHOTO_FULL_MAX_BYTES,
  PHOTO_FULL_MAX_EDGE,
  PHOTO_FULL_QUALITY,
  PHOTO_MIN_QUALITY,
  PHOTO_THUMB_MAX_EDGE,
  PHOTO_THUMB_QUALITY,
} from '../domain';
import type { DraftPhoto } from './store-contract';
import { uuid } from './uuid';

export interface EncodeStep {
  /** Long edge in px. */
  edge: number;
  quality: number;
}

/** The quality ladder at one size, then the size shrinks by this factor at the lowest quality. */
export const QUALITY_STEPS = [PHOTO_FULL_QUALITY, 0.72, PHOTO_MIN_QUALITY] as const;
export const SHRINK_FACTOR = 0.8;
/** Never shrink the full image below this edge (a 640 px JPEG at 0.6 is far under 2.5 MB anyway). */
export const MIN_FULL_EDGE = 640;

/** Target size for a long edge, never upscaling. */
export function fitSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  const scale = long > maxEdge ? maxEdge / long : 1;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function firstFullStep(width: number, height: number): EncodeStep {
  return { edge: Math.min(PHOTO_FULL_MAX_EDGE, Math.max(width, height, 1)), quality: PHOTO_FULL_QUALITY };
}

/**
 * The next attempt after an encode of `bytes` at `step`, or null when done (small enough, or nothing smaller
 * left to try). Quality first (0.82 → 0.72 → 0.6), then the edge shrinks by 20 % at 0.6.
 */
export function nextFullStep(step: EncodeStep, bytes: number): EncodeStep | null {
  if (bytes <= PHOTO_FULL_MAX_BYTES) return null;
  const i = QUALITY_STEPS.findIndex((q) => q <= step.quality + 1e-9 && q >= step.quality - 1e-9);
  if (i >= 0 && i < QUALITY_STEPS.length - 1) return { edge: step.edge, quality: QUALITY_STEPS[i + 1] as number };
  const edge = Math.round(step.edge * SHRINK_FACTOR);
  if (edge < MIN_FULL_EDGE) return null;
  return { edge, quality: PHOTO_MIN_QUALITY };
}

/** Runs the ladder with any encoder (unit-tested with a fake one). Returns the last blob and its step. */
export async function encodeWithinBudget(
  width: number,
  height: number,
  encode: (size: { width: number; height: number }, quality: number) => Promise<Blob>,
): Promise<{ blob: Blob; step: EncodeStep; size: { width: number; height: number } }> {
  let step: EncodeStep | null = firstFullStep(width, height);
  let last: { blob: Blob; step: EncodeStep; size: { width: number; height: number } } | null = null;
  while (step) {
    const size = fitSize(width, height, step.edge);
    const blob = await encode(size, step.quality);
    last = { blob, step, size };
    step = nextFullStep(step, blob.size);
  }
  if (!last) throw new Error('encode failed');
  return last;
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality);
  });
}

/** Draws the decoded image into a canvas of exactly `size` and encodes it. The canvas is released after. */
async function drawAndEncode(img: HTMLImageElement, size: { width: number; height: number }, quality: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    // JPEG has no alpha: paint white under transparent PNGs instead of black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, size.width, size.height);
    return await canvasToBlob(canvas, quality);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export class PhotoError extends Error {
  constructor() {
    super("Couldn't read that photo");
    this.name = 'PhotoError';
  }
}

/** File → compressed full image + thumbnail with a new photoId. */
export async function compressPhoto(file: Blob): Promise<DraftPhoto> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new PhotoError();
    }
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) throw new PhotoError();
    const full = await encodeWithinBudget(width, height, (size, q) => drawAndEncode(img, size, q));
    const thumb = await drawAndEncode(img, fitSize(width, height, PHOTO_THUMB_MAX_EDGE), PHOTO_THUMB_QUALITY);
    return { photoId: uuid(), blob: full.blob, thumbBlob: thumb, width: full.size.width, height: full.size.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}
