// Photo compression (spec §7 Photos) and on-device cleanup (design/DECISIONS.md v2.2 #10). Loaded on demand
// (preparePhoto imports it), so it never weighs on the first load of `/`. Everything runs on the phone: no
// extra request, no server work, and the upload is never bigger than the pipeline before cleanup made it.
//   * Decode through an <img> (object URL + decode()): browsers apply the EXIF orientation there.
//   * Crop (optional, normalised to the oriented photo) is taken straight from the decoded image.
//   * Never a full-size canvas (iOS caps canvas memory): the crop is drawn at twice the target size, then
//     halved exactly, so every output pixel is the average of a 2 × 2 block (area averaging). Screen
//     pixel-grid texture above the output's resolution is averaged away instead of aliasing into moiré.
//   * Cleanup (image-enhance.ts) on the ≤ 1600 px result only: auto levels, a light unsharp mask, each only
//     when the photo measures as needing it. Time-sliced, with a deadline; any failure or timeout skips it.
//   * Never bigger: the "reference" (the pipeline before cleanup: one draw straight to 1600 px) is encoded
//     too. The first of these that is no bigger than it is sent: the cleaned photo at 0.82, 0.76 or 0.72;
//     the area-averaged photo at 0.82; else the reference itself. Full + thumbnail together never exceed
//     the reference's full + thumbnail.
//   * Full: ≤ 1600 px long edge, JPEG 0.82; step the quality down to 0.6, then shrink the edge, until ≤ 2.5 MB.
//   * Thumb: ≤ 320 px, JPEG 0.7. Re-encoding drops the photo's EXIF (GPS included); stripJpegMetadata then
//     also drops the small Exif block Safari's encoder writes on its own, so no upload carries APP1 at all.
import {
  PHOTO_FULL_MAX_BYTES,
  PHOTO_FULL_MAX_EDGE,
  PHOTO_FULL_QUALITY,
  PHOTO_MIN_QUALITY,
  PHOTO_THUMB_MAX_EDGE,
  PHOTO_THUMB_QUALITY,
} from '../domain';
import { cropToPixels, type PixelRegion } from './crop';
import { enhanceSteps, runSliced, type EnhanceResult } from './image-enhance';
import type { DraftPhoto, PreparePhotoOptions } from './store-contract';
import { uuid } from './uuid';

export interface EncodeStep {
  /** Long edge in px. */
  edge: number;
  quality: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The quality ladder at one size, then the size shrinks by this factor at the lowest quality. */
export const QUALITY_STEPS = [PHOTO_FULL_QUALITY, 0.72, PHOTO_MIN_QUALITY] as const;
export const SHRINK_FACTOR = 0.8;
/** Never shrink the full image below this edge (a 640 px JPEG at 0.6 is far under 2.5 MB anyway). */
export const MIN_FULL_EDGE = 640;
/** The cleaned photo's later tries when it came out bigger than the reference at PHOTO_FULL_QUALITY. */
export const ENHANCED_RETRY_QUALITIES = [0.76, 0.72] as const;
/** Cleanup gives up (plain photo) after this long; it takes well under 400 ms on a mid-range iPhone. */
export const ENHANCE_DEADLINE_MS = 1_000;
/** Cleanup yields to the page this often, so taps and the spinner stay smooth. */
export const ENHANCE_SLICE_MS = 12;

/** Target size for a long edge, never upscaling. */
export function fitSize(width: number, height: number, maxEdge: number): Size {
  const long = Math.max(width, height);
  const scale = long > maxEdge ? maxEdge / long : 1;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * How a `width` × `height` source becomes at most `maxEdge`: `final`, drawn through `stage` (exactly twice
 * `final` on each side, then halved: area averaging) whenever the source is bigger than `final`. A source
 * that already fits is drawn once, at its own size.
 */
export function downscalePlan(width: number, height: number, maxEdge: number): { final: Size; stage: Size | null } {
  const final = fitSize(width, height, maxEdge);
  const shrinking = Math.max(width, height) > Math.max(final.width, final.height);
  return { final, stage: shrinking ? { width: final.width * 2, height: final.height * 2 } : null };
}

export function firstFullStep(width: number, height: number): EncodeStep {
  return { edge: Math.min(PHOTO_FULL_MAX_EDGE, Math.max(width, height, 1)), quality: PHOTO_FULL_QUALITY };
}

/**
 * The next attempt after an encode of `bytes` at `step`, or null when done (small enough, or nothing smaller
 * left to try). Quality first (0.82 → 0.72 → 0.6; from any other quality, the next lower one), then the edge
 * shrinks by 20 % at 0.6.
 */
export function nextFullStep(step: EncodeStep, bytes: number): EncodeStep | null {
  if (bytes <= PHOTO_FULL_MAX_BYTES) return null;
  const lower = QUALITY_STEPS.find((q) => q < step.quality - 1e-9);
  if (lower !== undefined) return { edge: step.edge, quality: lower };
  const edge = Math.round(step.edge * SHRINK_FACTOR);
  if (edge < MIN_FULL_EDGE) return null;
  return { edge, quality: PHOTO_MIN_QUALITY };
}

/**
 * Runs the ladder with any encoder (unit-tested with a fake one). Returns the last blob and its step.
 * `start` continues from an encode already made (its blob and step).
 */
export async function encodeWithinBudget(
  width: number,
  height: number,
  encode: (size: Size, quality: number) => Promise<Blob>,
  start?: { blob: Blob; step: EncodeStep },
): Promise<{ blob: Blob; step: EncodeStep; size: Size }> {
  let last: { blob: Blob; step: EncodeStep; size: Size } | null = start
    ? { blob: start.blob, step: start.step, size: fitSize(width, height, start.step.edge) }
    : null;
  let step: EncodeStep | null = start ? nextFullStep(start.step, start.blob.size) : firstFullStep(width, height);
  while (step) {
    const size = fitSize(width, height, step.edge);
    const blob = await encode(size, step.quality);
    last = { blob, step, size };
    step = nextFullStep(step, blob.size);
  }
  if (!last) throw new Error('encode failed');
  return last;
}

export type UploadSource = 'cleaned' | 'averaged' | 'reference';

export interface UploadChoice {
  blob: Blob;
  quality: number;
  source: UploadSource;
  /** The reference encode (the pipeline before cleanup, at PHOTO_FULL_QUALITY): the size limit. */
  reference: Blob;
}

/**
 * The full-size upload: the first candidate no bigger than the reference (the pipeline before cleanup,
 * at 0.82): the cleaned photo at 0.82, then at each ENHANCED_RETRY_QUALITIES; the area-averaged photo at
 * 0.82; else the reference. A candidate whose encode fails is skipped. Unit-tested with fake encoders.
 */
export async function pickUpload(
  reference: (quality: number) => Promise<Blob>,
  averaged: ((quality: number) => Promise<Blob>) | null,
  cleaned: ((quality: number) => Promise<Blob>) | null,
): Promise<UploadChoice> {
  const q0 = PHOTO_FULL_QUALITY;
  const attempt = (encode: ((quality: number) => Promise<Blob>) | null, q: number) =>
    encode ? encode(q).catch(() => null) : Promise.resolve(null);
  // In parallel: the reference with the cleaned photo, or with the averaged one when nothing was cleaned.
  const [ref, first, plainFirst] = await Promise.all([reference(q0), attempt(cleaned, q0), cleaned ? null : attempt(averaged, q0)]);
  const choice = (blob: Blob, quality: number, source: UploadSource): UploadChoice => ({ blob, quality, source, reference: ref });
  if (first) {
    if (first.size <= ref.size) return choice(first, q0, 'cleaned');
    for (const q of ENHANCED_RETRY_QUALITIES) {
      const retry = await attempt(cleaned, q);
      if (!retry) break;
      if (retry.size <= ref.size) return choice(retry, q, 'cleaned');
    }
  }
  const plain = plainFirst ?? (cleaned ? await attempt(averaged, q0) : null);
  if (plain && plain.size <= ref.size) return choice(plain, q0, 'averaged');
  return choice(ref, q0, 'reference');
}

/** applied · not-needed (measured fine) · larger (the cleaned copy came out bigger, so not sent) · off · failed · timeout. */
export type CleanupOutcome = 'applied' | 'not-needed' | 'larger' | 'off' | 'failed' | 'timeout';

/**
 * Runs `enhance` on a copy of the plain image and returns the cleaned copy, or the plain one when cleanup
 * is off, finds nothing to do, throws or times out. Generic so it is unit-tested without a canvas.
 */
export async function withCleanup<T>(
  plain: T,
  enhance: ((plain: T) => Promise<T | null>) | null,
): Promise<{ image: T; outcome: CleanupOutcome }> {
  if (!enhance) return { image: plain, outcome: 'off' };
  try {
    const out = await enhance(plain);
    return out ? { image: out, outcome: 'applied' } : { image: plain, outcome: 'not-needed' };
  } catch (error) {
    return { image: plain, outcome: error instanceof Error && error.name === 'EnhanceTimeout' ? 'timeout' : 'failed' };
  }
}

/** APP1 (Exif, XMP), APP13 (IPTC / Photoshop) and COM: metadata, never needed to show the photo. */
const METADATA_MARKERS = new Set([0xe1, 0xed, 0xfe]);

/**
 * The JPEG without its metadata segments (APP1, APP13, comments), everything else byte for byte: JFIF,
 * the ICC profile (APP2), Adobe (APP14), tables and the image data. Anything that does not parse as a
 * JPEG header is returned unchanged. Pure; unit-tested.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const keep: Array<[number, number]> = [[0, 2]];
  let i = 2;
  let dropped = false;
  for (;;) {
    if (i + 4 > bytes.length || bytes[i] !== 0xff) return bytes;
    const marker = bytes[i + 1] as number;
    // Start of scan (image data follows) or end of image: keep the rest as it is.
    if (marker === 0xda || marker === 0xd9) break;
    const len = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
    if (len < 2 || i + 2 + len > bytes.length) return bytes;
    if (METADATA_MARKERS.has(marker)) dropped = true;
    else keep.push([i, i + 2 + len]);
    i += 2 + len;
  }
  if (!dropped) return bytes;
  keep.push([i, bytes.length]);
  const out = new Uint8Array(keep.reduce((n, [a, b]) => n + b - a, 0));
  let o = 0;
  for (const [a, b] of keep) {
    out.set(bytes.subarray(a, b), o);
    o += b - a;
  }
  return out;
}

async function withoutMetadata(blob: Blob): Promise<Blob> {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const out = stripJpegMetadata(bytes);
    return out === bytes ? blob : new Blob([out as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
  } catch {
    return blob;
  }
}

// ---------------------------------------------------------------------------------------------------
// Canvas plumbing (browser only)
// ---------------------------------------------------------------------------------------------------

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality);
  });
}

function release(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/** A new canvas of `size` with `region` of `src` drawn into it, white under any transparency (JPEG has none). */
function drawRegion(src: CanvasImageSource, region: PixelRegion, size: Size, quality: ImageSmoothingQuality): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    release(canvas);
    throw new Error('no canvas');
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = quality;
  ctx.drawImage(src, region.sx, region.sy, region.sw, region.sh, 0, 0, size.width, size.height);
  return canvas;
}

const whole = (s: Size): PixelRegion => ({ sx: 0, sy: 0, sw: s.width, sh: s.height });

/**
 * `region` of `src` at `maxEdge`, area-averaged (downscalePlan): drawn at twice the size with high-quality
 * smoothing, then halved with plain bilinear sampling, which at exactly 2:1 is the mean of each 2 × 2 block.
 */
function drawScaled(src: CanvasImageSource, region: PixelRegion, maxEdge: number): HTMLCanvasElement {
  const plan = downscalePlan(region.sw, region.sh, maxEdge);
  if (!plan.stage) return drawRegion(src, region, plan.final, 'high');
  const stage = drawRegion(src, region, plan.stage, 'high');
  try {
    return drawRegion(stage, whole(plan.stage), plan.final, 'low');
  } finally {
    release(stage);
  }
}

/** Encodes `canvas` at `size` (its own size, or a smaller copy for a later ladder step). */
async function encodeAt(canvas: HTMLCanvasElement, size: Size, quality: number): Promise<Blob> {
  if (size.width === canvas.width && size.height === canvas.height) return canvasToBlob(canvas, quality);
  const copy = drawRegion(canvas, whole(canvas), size, 'high');
  try {
    return await canvasToBlob(copy, quality);
  } finally {
    release(copy);
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** A macrotask break that is not clamped like nested setTimeout (scheduler.yield where there is one). */
function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}

/** The cleaned copy of `plain` (a new canvas), or null when the photo needs nothing. */
async function enhanceCanvas(plain: HTMLCanvasElement, deadline: number): Promise<HTMLCanvasElement | null> {
  const ctx = plain.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  const pixels = ctx.getImageData(0, 0, plain.width, plain.height);
  const result: EnhanceResult = await runSliced(enhanceSteps(pixels), { now, deadline, sliceMs: ENHANCE_SLICE_MS, yieldToMain });
  if (!result.applied) return null;
  const out = document.createElement('canvas');
  out.width = plain.width;
  out.height = plain.height;
  const octx = out.getContext('2d');
  if (!octx) {
    release(out);
    throw new Error('no canvas');
  }
  octx.putImageData(pixels, 0, 0);
  return out;
}

/** Timing for anyone measuring (DevTools, the e2e benchmark); never logged, carries no photo content. */
function measure(name: string, start: number, detail: Record<string, string | number | boolean>): void {
  try {
    performance.measure(name, { start, end: now(), detail });
  } catch {
    // Older browsers without User Timing L3: nothing to record.
  }
}

export class PhotoError extends Error {
  constructor() {
    super("Couldn't read that photo");
    this.name = 'PhotoError';
  }
}

interface Encoded {
  blob: Blob;
  thumb: Blob;
  size: Size;
}

interface CleanEncoded extends Encoded {
  outcome: CleanupOutcome;
  source: UploadSource;
  enhanceMs: number;
  /** The full image as the pipeline before cleanup would have sent it. */
  referenceBytes: number;
}

/**
 * Crop → area-averaged ≤ 1600 px → cleanup (when it helps) → the smallest-acceptable choice against the
 * reference → the size ladder; the thumbnail from the same pixels.
 */
async function cleanPipeline(img: HTMLImageElement, region: PixelRegion, enhance: boolean): Promise<CleanEncoded> {
  const averaged = drawScaled(img, region, PHOTO_FULL_MAX_EDGE);
  const size: Size = { width: averaged.width, height: averaged.height };
  let cleaned: HTMLCanvasElement | null = null;
  let reference: HTMLCanvasElement | null = null;
  const thumbs: HTMLCanvasElement[] = [];
  try {
    const t0 = now();
    const { image, outcome } = await withCleanup(averaged, enhance ? (p) => enhanceCanvas(p, t0 + ENHANCE_DEADLINE_MS) : null);
    const enhanceMs = Math.round(now() - t0);
    if (image !== averaged) cleaned = image;
    reference = drawRegion(img, region, size, 'high');
    const ref = reference;
    const cleanedCanvas = cleaned;
    const picked = await pickUpload(
      (q) => canvasToBlob(ref, q),
      (q) => canvasToBlob(averaged, q),
      cleanedCanvas ? (q) => canvasToBlob(cleanedCanvas, q) : null,
    );
    const kept: CleanupOutcome = outcome === 'applied' && picked.source !== 'cleaned' ? 'larger' : outcome;
    const ladder = (source: HTMLCanvasElement, start: { blob: Blob; step: EncodeStep }) =>
      encodeWithinBudget(size.width, size.height, (s, q) => encodeAt(source, s, q), start);
    const edge = Math.max(size.width, size.height);
    const referenceBytes = picked.reference.size;
    // The reference thumbnail (drawn straight from the photo, as before): made only when it is needed.
    let refThumb: Blob | null = null;
    const referenceThumb = async (): Promise<Blob> => {
      if (refThumb) return refThumb;
      const canvas = drawRegion(img, region, fitSize(region.sw, region.sh, PHOTO_THUMB_MAX_EDGE), 'high');
      thumbs.push(canvas);
      refThumb = await canvasToBlob(canvas, PHOTO_THUMB_QUALITY);
      return refThumb;
    };
    const asReference = async (): Promise<CleanEncoded> => {
      const full = await ladder(ref, { blob: picked.reference, step: { edge, quality: PHOTO_FULL_QUALITY } });
      const outcomeNow: CleanupOutcome = kept === 'applied' ? 'larger' : kept;
      return { blob: full.blob, thumb: await referenceThumb(), size: full.size, outcome: outcomeNow, source: 'reference', enhanceMs, referenceBytes };
    };
    if (picked.source === 'reference') return await asReference();
    const source = picked.source === 'cleaned' && cleanedCanvas ? cleanedCanvas : averaged;
    const full = await ladder(source, { blob: picked.blob, step: { edge, quality: picked.quality } });
    const thumbCanvas = drawScaled(source, whole(size), PHOTO_THUMB_MAX_EDGE);
    thumbs.push(thumbCanvas);
    const thumb = await canvasToBlob(thumbCanvas, PHOTO_THUMB_QUALITY);
    // Full + thumbnail together never exceed the reference pair. Within the reference full alone it can't,
    // so the reference thumbnail is only made when the pair comes closer than that.
    const total = full.blob.size + thumb.size;
    if (total > referenceBytes && total > referenceBytes + (await referenceThumb()).size) return await asReference();
    return { blob: full.blob, thumb, size: full.size, outcome: kept, source: picked.source, enhanceMs, referenceBytes };
  } finally {
    thumbs.forEach(release);
    release(reference);
    release(cleaned);
    release(averaged);
  }
}

/** The pipeline before cleanup (one draw per output size), kept as the fallback; it still honours the crop. */
async function plainPipeline(img: HTMLImageElement, region: PixelRegion): Promise<Encoded> {
  const full = await encodeWithinBudget(region.sw, region.sh, async (size, q) => {
    const canvas = drawRegion(img, region, size, 'high');
    try {
      return await canvasToBlob(canvas, q);
    } finally {
      release(canvas);
    }
  });
  const thumbCanvas = drawRegion(img, region, fitSize(region.sw, region.sh, PHOTO_THUMB_MAX_EDGE), 'high');
  try {
    return { blob: full.blob, thumb: await canvasToBlob(thumbCanvas, PHOTO_THUMB_QUALITY), size: full.size };
  } finally {
    release(thumbCanvas);
  }
}

/** File → compressed full image + thumbnail with a new photoId (optionally cropped; cleaned by default). */
export async function compressPhoto(file: Blob, options: PreparePhotoOptions = {}): Promise<DraftPhoto> {
  const started = now();
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
    const region = cropToPixels(options.crop, width, height);
    let out: Encoded;
    let outcome: CleanupOutcome = 'failed';
    let source: UploadSource | 'fallback' = 'fallback';
    let enhanceMs = 0;
    let referenceBytes = 0;
    try {
      const clean = await cleanPipeline(img, region, options.enhance !== false);
      ({ outcome, source, enhanceMs, referenceBytes } = clean);
      out = clean;
    } catch {
      out = await plainPipeline(img, region);
    }
    out = { ...out, blob: await withoutMetadata(out.blob), thumb: await withoutMetadata(out.thumb) };
    measure('lp-photo-prepare', started, {
      inBytes: file.size,
      outBytes: out.blob.size,
      thumbBytes: out.thumb.size,
      // The full image as the pipeline before cleanup would have sent it (0 when the fallback ran).
      referenceBytes,
      source,
      width: out.size.width,
      height: out.size.height,
      cropped: region.sw !== width || region.sh !== height,
      cleanup: outcome,
      enhanceMs,
    });
    return { photoId: uuid(), blob: out.blob, thumbBlob: out.thumb, width: out.size.width, height: out.size.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}
