// Quick crop and the photo pipeline's pure rules (design/DECISIONS.md v2.2 #10): crop rectangle clamping,
// corner drags, keyboard nudges, pixel regions; the area-averaging downscale plan, the size cap, the
// "never bigger" choice and the fallback to the plain photo when cleanup fails or times out.
import { describe, expect, it } from 'vitest';
import {
  FULL_CROP,
  MIN_CROP,
  NUDGE,
  NUDGE_BIG,
  arrowDelta,
  clampCrop,
  cropFromPoints,
  cropToPixels,
  describeCrop,
  isFullCrop,
  moveCrop,
  nudgeCrop,
  resizeCorner,
  type CropRect,
} from '@/lib/client/crop';
import {
  ENHANCED_RETRY_QUALITIES,
  downscalePlan,
  encodeWithinBudget,
  nextFullStep,
  pickUpload,
  stripJpegMetadata,
  withCleanup,
} from '@/lib/client/image';
import { EnhanceTimeout } from '@/lib/client/image-enhance';
import { PHOTO_FULL_MAX_BYTES, PHOTO_FULL_MAX_EDGE, PHOTO_FULL_QUALITY } from '@/lib/domain';

const close = (r: CropRect, e: CropRect) => {
  expect(r.x).toBeCloseTo(e.x, 9);
  expect(r.y).toBeCloseTo(e.y, 9);
  expect(r.width).toBeCloseTo(e.width, 9);
  expect(r.height).toBeCloseTo(e.height, 9);
};

const inside = (r: CropRect) => {
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.y).toBeGreaterThanOrEqual(0);
  expect(r.x + r.width).toBeLessThanOrEqual(1 + 1e-12);
  expect(r.y + r.height).toBeLessThanOrEqual(1 + 1e-12);
  expect(r.width).toBeGreaterThanOrEqual(MIN_CROP - 1e-12);
  expect(r.height).toBeGreaterThanOrEqual(MIN_CROP - 1e-12);
};

describe('crop rectangle', () => {
  it('starts as the whole photo, which is "no crop"', () => {
    expect(isFullCrop(FULL_CROP)).toBe(true);
    expect(isFullCrop(null)).toBe(true);
    expect(isFullCrop({ x: 0.001, y: 0, width: 0.999, height: 1 })).toBe(true);
    expect(isFullCrop({ x: 0.05, y: 0, width: 0.95, height: 1 })).toBe(false);
  });

  it('clamps into the photo, to the minimum size, and treats nonsense as the whole photo', () => {
    close(clampCrop({ x: -0.2, y: 0.95, width: 0.5, height: 0.5 }), { x: 0, y: 0.5, width: 0.5, height: 0.5 });
    close(clampCrop({ x: 0.5, y: 0.5, width: 0.01, height: 2 }), { x: 0.5, y: 0, width: MIN_CROP, height: 1 });
    close(clampCrop({ x: Number.NaN, y: Infinity, width: Number.NaN, height: -1 }), { x: 0, y: 0, width: 1, height: MIN_CROP });
  });

  it('drags a corner with the opposite corner fixed, stopping at the edges and at the minimum size', () => {
    // Cut the bezel: top left in to (0.2, 0.15), bottom right in to (0.8, 0.9).
    const a = resizeCorner(FULL_CROP, 'nw', 0.2, 0.15);
    close(a, { x: 0.2, y: 0.15, width: 0.8, height: 0.85 });
    const b = resizeCorner(a, 'se', 0.8, 0.9);
    close(b, { x: 0.2, y: 0.15, width: 0.6, height: 0.75 });
    // Past the opposite corner: it stops MIN_CROP short and never flips.
    const c = resizeCorner(b, 'ne', 0.05, 0.99);
    close(c, { x: 0.2, y: 0.9 - MIN_CROP, width: MIN_CROP, height: MIN_CROP });
    // Outside the photo: stops at the edge.
    close(resizeCorner(b, 'sw', -3, 7), { x: 0, y: 0.15, width: 0.8, height: 0.85 });
    for (const r of [a, b, c]) inside(r);
  });

  it('moves the selection without changing its size, stopping at the edges', () => {
    const r = { x: 0.2, y: 0.2, width: 0.5, height: 0.4 };
    close(moveCrop(r, 0.1, -0.05), { x: 0.3, y: 0.15, width: 0.5, height: 0.4 });
    close(moveCrop(r, 0.9, 0.9), { x: 0.5, y: 0.6, width: 0.5, height: 0.4 });
    close(moveCrop(r, -1, -1), { x: 0, y: 0, width: 0.5, height: 0.4 });
  });

  it('draws a new rectangle in any direction, at least the minimum size, inside the photo', () => {
    close(cropFromPoints(0.7, 0.8, 0.2, 0.1), { x: 0.2, y: 0.1, width: 0.5, height: 0.7 });
    close(cropFromPoints(0.5, 0.5, 0.52, 0.51), { x: 0.5, y: 0.5, width: MIN_CROP, height: MIN_CROP });
    const edge = cropFromPoints(0.98, 0.97, 1.4, 1.2);
    close(edge, { x: 1 - MIN_CROP, y: 1 - MIN_CROP, width: MIN_CROP, height: MIN_CROP });
    inside(edge);
  });

  it('nudges with the arrow keys: 1 %, or 5 % with Shift', () => {
    expect(arrowDelta('ArrowLeft', false)).toEqual({ dx: -NUDGE, dy: 0 });
    expect(arrowDelta('ArrowDown', true)).toEqual({ dx: 0, dy: NUDGE_BIG });
    expect(arrowDelta('Enter', false)).toBeNull();
    const r = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
    close(nudgeCrop(r, 'move', NUDGE, 0), { x: 0.21, y: 0.2, width: 0.5, height: 0.5 });
    close(nudgeCrop(r, 'se', -NUDGE_BIG, 0), { x: 0.2, y: 0.2, width: 0.45, height: 0.5 });
    close(nudgeCrop(FULL_CROP, 'nw', NUDGE, NUDGE), { x: 0.01, y: 0.01, width: 0.99, height: 0.99 });
    // The whole photo can't grow or move.
    close(nudgeCrop(FULL_CROP, 'move', -NUDGE, 0), FULL_CROP);
    close(nudgeCrop(FULL_CROP, 'se', NUDGE, NUDGE), FULL_CROP);
  });

  it('turns a crop into whole source pixels, always inside the image', () => {
    expect(cropToPixels(null, 4032, 3024)).toEqual({ sx: 0, sy: 0, sw: 4032, sh: 3024 });
    expect(cropToPixels(FULL_CROP, 4032, 3024)).toEqual({ sx: 0, sy: 0, sw: 4032, sh: 3024 });
    expect(cropToPixels({ x: 0.25, y: 0.1, width: 0.5, height: 0.8 }, 4032, 3024)).toEqual({ sx: 1008, sy: 302, sw: 2016, sh: 2420 });
    // A tiny image still gets at least one pixel.
    const tiny = cropToPixels({ x: 0.9, y: 0.9, width: 0.1, height: 0.1 }, 3, 2);
    expect(tiny.sw).toBeGreaterThanOrEqual(1);
    expect(tiny.sh).toBeGreaterThanOrEqual(1);
    expect(tiny.sx + tiny.sw).toBeLessThanOrEqual(3);
    expect(tiny.sy + tiny.sh).toBeLessThanOrEqual(2);
    // Out-of-range input is clamped, never read outside the image.
    const wild = cropToPixels({ x: -1, y: 0.5, width: 5, height: 5 }, 100, 100);
    expect(wild.sx).toBe(0);
    expect(wild.sy + wild.sh).toBeLessThanOrEqual(100);
  });

  it('describes the crop for screen readers', () => {
    expect(describeCrop(FULL_CROP)).toBe('Whole photo');
    expect(describeCrop({ x: 0.1, y: 0.2, width: 0.72, height: 0.6 })).toBe('Cropped to 72 by 60 percent of the photo');
  });
});

describe('area-averaging downscale plan', () => {
  it('draws a big photo at exactly twice the output, then halves it', () => {
    expect(downscalePlan(4032, 3024, PHOTO_FULL_MAX_EDGE)).toEqual({ final: { width: 1600, height: 1200 }, stage: { width: 3200, height: 2400 } });
    // A crop of the phone screen (1500 × 2000 of a 12 MP photo).
    expect(downscalePlan(1500, 2000, PHOTO_FULL_MAX_EDGE)).toEqual({ final: { width: 1200, height: 1600 }, stage: { width: 2400, height: 3200 } });
    // The thumbnail from the 1600 px image.
    expect(downscalePlan(1600, 1200, 320)).toEqual({ final: { width: 320, height: 240 }, stage: { width: 640, height: 480 } });
  });

  it('never upscales, and draws a photo that already fits once', () => {
    expect(downscalePlan(800, 600, PHOTO_FULL_MAX_EDGE)).toEqual({ final: { width: 800, height: 600 }, stage: null });
    expect(downscalePlan(1600, 900, PHOTO_FULL_MAX_EDGE)).toEqual({ final: { width: 1600, height: 900 }, stage: null });
    expect(downscalePlan(1, 1, PHOTO_FULL_MAX_EDGE)).toEqual({ final: { width: 1, height: 1 }, stage: null });
  });

  it('keeps the stage within one iOS canvas (≤ 16.7 MP) for any shape', () => {
    for (const [w, h] of [
      [8064, 6048],
      [6000, 6000],
      [12000, 1000],
      [1601, 1601],
    ] as const) {
      const { stage } = downscalePlan(w, h, PHOTO_FULL_MAX_EDGE);
      expect(stage, `${w}×${h}`).not.toBeNull();
      expect((stage?.width ?? 0) * (stage?.height ?? 0)).toBeLessThanOrEqual(16_777_216);
    }
  });
});

describe('size cap with a cleaned photo', () => {
  it('continues the quality ladder from any quality', () => {
    const big = PHOTO_FULL_MAX_BYTES + 1;
    expect(nextFullStep({ edge: 1600, quality: 0.76 }, big)).toEqual({ edge: 1600, quality: 0.72 });
    expect(nextFullStep({ edge: 1600, quality: 0.72 }, big)).toEqual({ edge: 1600, quality: 0.6 });
    expect(nextFullStep({ edge: 1600, quality: 0.76 }, PHOTO_FULL_MAX_BYTES)).toBeNull();
  });

  it('starts from an encode already made, and still ends ≤ 2.5 MB', async () => {
    const calls: number[] = [];
    const encode = async (size: { width: number; height: number }, q: number) => {
      calls.push(q);
      return new Blob([new Uint8Array(Math.round(size.width * size.height * q * 2.4))]);
    };
    const first = new Blob([new Uint8Array(PHOTO_FULL_MAX_BYTES + 100)]);
    const out = await encodeWithinBudget(1600, 1200, encode, { blob: first, step: { edge: 1600, quality: 0.76 } });
    expect(calls[0]).toBe(0.72);
    expect(out.blob.size).toBeLessThanOrEqual(PHOTO_FULL_MAX_BYTES);
    // Already small enough: no further encode at all.
    calls.length = 0;
    const small = new Blob([new Uint8Array(400_000)]);
    const kept = await encodeWithinBudget(1600, 1200, encode, { blob: small, step: { edge: 1600, quality: PHOTO_FULL_QUALITY } });
    expect(calls).toEqual([]);
    expect(kept.blob).toBe(small);
    expect(kept.size).toEqual({ width: 1600, height: 1200 });
  });
});

describe('never bigger than the pipeline before cleanup (the reference)', () => {
  const blob = (n: number) => new Blob([new Uint8Array(n)]);
  /** A fake encoder: bytes by quality, and the qualities it was asked for. */
  const encoder = (sizes: Record<number, number>) => {
    const asked: number[] = [];
    const encode = async (q: number) => {
      asked.push(q);
      const n = sizes[q];
      if (n === undefined) throw new Error(`no size for ${q}`);
      return blob(n);
    };
    return { asked, encode };
  };
  const q0 = PHOTO_FULL_QUALITY;

  it('sends the cleaned photo when it is no bigger at the same quality', async () => {
    const avg = encoder({ [q0]: 490 });
    const out = await pickUpload(async () => blob(500), avg.encode, encoder({ [q0]: 480 }).encode);
    expect(out).toMatchObject({ quality: q0, source: 'cleaned' });
    expect(out.blob.size).toBe(480);
    expect(out.reference.size).toBe(500);
    // The averaged photo was not even encoded.
    expect(avg.asked).toEqual([]);
  });

  it('steps the cleaned photo down 0.76, then 0.72, before giving up on it', async () => {
    const cleaned = encoder({ [q0]: 600, 0.76: 540, 0.72: 495 });
    const out = await pickUpload(async () => blob(500), encoder({ [q0]: 510 }).encode, cleaned.encode);
    expect(cleaned.asked).toEqual([q0, ...ENHANCED_RETRY_QUALITIES]);
    expect(out).toMatchObject({ quality: 0.72, source: 'cleaned' });
    expect(out.blob.size).toBeLessThanOrEqual(500);
  });

  it('falls back to the area-averaged photo, then to the reference', async () => {
    const averaged = await pickUpload(async () => blob(500), encoder({ [q0]: 499 }).encode, encoder({ [q0]: 700, 0.76: 650, 0.72: 600 }).encode);
    expect(averaged).toMatchObject({ quality: q0, source: 'averaged' });
    expect(averaged.blob.size).toBe(499);
    const reference = await pickUpload(async () => blob(500), encoder({ [q0]: 501 }).encode, encoder({ [q0]: 700, 0.76: 650, 0.72: 600 }).encode);
    expect(reference).toMatchObject({ quality: q0, source: 'reference' });
    expect(reference.blob.size).toBe(500);
  });

  it('skips a candidate whose encode fails', async () => {
    const failing = async () => {
      throw new Error('encode failed');
    };
    const out = await pickUpload(async () => blob(500), encoder({ [q0]: 450 }).encode, failing);
    expect(out).toMatchObject({ source: 'averaged' });
    const none = await pickUpload(async () => blob(500), failing, failing);
    expect(none).toMatchObject({ source: 'reference' });
    expect(none.blob.size).toBe(500);
  });

  it('with nothing cleaned (a sharp, well-exposed photo): the averaged photo if no bigger, else the reference', async () => {
    const avg = encoder({ [q0]: 480 });
    expect(await pickUpload(async () => blob(500), avg.encode, null)).toMatchObject({ source: 'averaged' });
    expect(avg.asked).toEqual([q0]);
    expect(await pickUpload(async () => blob(500), encoder({ [q0]: 506 }).encode, null)).toMatchObject({ source: 'reference' });
  });

  it('never sends more than the reference, whatever the sizes', async () => {
    for (let i = 0; i < 200; i += 1) {
      const r = 300 + ((i * 37) % 400);
      const sizes = { [q0]: 200 + ((i * 53) % 500), 0.76: 200 + ((i * 71) % 450), 0.72: 200 + ((i * 89) % 400) };
      const out = await pickUpload(async () => blob(r), encoder({ [q0]: 200 + ((i * 97) % 600) }).encode, i % 3 ? encoder(sizes).encode : null);
      expect(out.blob.size).toBeLessThanOrEqual(r);
    }
  });
});

describe('fallback to the plain photo', () => {
  const plain = { name: 'plain' };
  const cleaned = { name: 'cleaned' };

  it('uses the cleaned image only when cleanup produced one', async () => {
    expect(await withCleanup(plain, async () => cleaned)).toEqual({ image: cleaned, outcome: 'applied' });
    expect(await withCleanup(plain, async () => null)).toEqual({ image: plain, outcome: 'not-needed' });
    expect(await withCleanup(plain, null)).toEqual({ image: plain, outcome: 'off' });
  });

  it('keeps the plain image when cleanup throws or runs out of time', async () => {
    expect(
      await withCleanup(plain, async () => {
        throw new Error('getImageData blocked');
      }),
    ).toEqual({ image: plain, outcome: 'failed' });
    expect(
      await withCleanup(plain, async () => {
        throw new EnhanceTimeout();
      }),
    ).toEqual({ image: plain, outcome: 'timeout' });
  });
});

describe('no metadata in the upload', () => {
  /** One marker segment: FF, marker, 2-byte length (payload + 2), payload. */
  const seg = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
  const ascii = (t: string) => [...t].map((c) => c.charCodeAt(0));
  const SOI = [0xff, 0xd8];
  const APP0 = seg(0xe0, ascii('JFIF\0'));
  // Safari's own block (ColorSpace, pixel size) and a camera's (Make, GPS): both are APP1 "Exif".
  const APP1 = seg(0xe1, [...ascii('Exif\0\0'), ...ascii('II*\0'), 8, 0, 0, 0, ...ascii('TESTCAM GPS')]);
  const APP2 = seg(0xe2, ascii('ICC_PROFILE\0'));
  const APP13 = seg(0xed, ascii('Photoshop 3.0\0'));
  const COM = seg(0xfe, ascii('taken at 28.4N 81.4W'));
  const DQT = seg(0xdb, [0, 1, 2, 3]);
  const SOS = [...seg(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0x34, 0xff, 0x00, 0x56];
  const EOI = [0xff, 0xd9];

  it('drops APP1 (Exif), APP13 and comments, keeping everything else byte for byte', () => {
    const jpeg = Uint8Array.from([...SOI, ...APP0, ...APP1, ...APP2, ...APP13, ...COM, ...DQT, ...SOS, ...EOI]);
    const out = stripJpegMetadata(jpeg);
    expect([...out]).toEqual([...SOI, ...APP0, ...APP2, ...DQT, ...SOS, ...EOI]);
    expect(Buffer.from(out).includes(Buffer.from('Exif'))).toBe(false);
    expect(Buffer.from(out).includes(Buffer.from('TESTCAM'))).toBe(false);
  });

  it('returns the same bytes when there is nothing to drop, or it is not a JPEG it can read', () => {
    const clean = Uint8Array.from([...SOI, ...APP0, ...DQT, ...SOS, ...EOI]);
    expect(stripJpegMetadata(clean)).toBe(clean);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(stripJpegMetadata(png)).toBe(png);
    // A segment length that runs past the end: untouched rather than guessed at.
    const truncated = Uint8Array.from([...SOI, 0xff, 0xe1, 0x40, 0x00, 1, 2, 3]);
    expect(stripJpegMetadata(truncated)).toBe(truncated);
  });
});
