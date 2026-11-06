// Quick-crop rectangle math (design/DECISIONS.md v2.2 #10). Pure; unit-tested.
// A crop is normalised to the photo as shown (0..1 on each axis, EXIF orientation already applied), so one
// rectangle fits the on-screen preview at any size and the decoded image's natural pixels alike.

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** nw = top left, ne = top right, sw = bottom left, se = bottom right. */
export type CropCorner = 'nw' | 'ne' | 'sw' | 'se';

export const FULL_CROP: Readonly<CropRect> = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

/** The smallest selection, as a fraction of each side (a phone screen in a photo is far bigger). */
export const MIN_CROP = 0.1;

/** Keyboard steps: an arrow key moves 1 % of the photo, Shift + arrow 5 %. */
export const NUDGE = 0.01;
export const NUDGE_BIG = 0.05;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

/** Inside the photo and at least `min` on each side; anything non-finite becomes the whole photo. */
export function clampCrop(r: CropRect, min: number = MIN_CROP): CropRect {
  const width = clamp(finite(r.width, 1), min, 1);
  const height = clamp(finite(r.height, 1), min, 1);
  return {
    x: clamp(finite(r.x, 0), 0, 1 - width),
    y: clamp(finite(r.y, 0), 0, 1 - height),
    width,
    height,
  };
}

/** True when the selection is (within `eps`) the whole photo: a crop that changes nothing. */
export function isFullCrop(r: CropRect | null | undefined, eps = 0.002): boolean {
  if (!r) return true;
  return r.x <= eps && r.y <= eps && r.x + r.width >= 1 - eps && r.y + r.height >= 1 - eps;
}

/** The same selection moved by (dx, dy), stopped at the photo's edges. */
export function moveCrop(r: CropRect, dx: number, dy: number): CropRect {
  const c = clampCrop(r);
  return clampCrop({ ...c, x: c.x + finite(dx, 0), y: c.y + finite(dy, 0) });
}

const isLeft = (corner: CropCorner) => corner === 'nw' || corner === 'sw';
const isTop = (corner: CropCorner) => corner === 'nw' || corner === 'ne';

/** Where a corner of the selection is. */
export function cornerPoint(r: CropRect, corner: CropCorner): { x: number; y: number } {
  return { x: isLeft(corner) ? r.x : r.x + r.width, y: isTop(corner) ? r.y : r.y + r.height };
}

/**
 * The selection with one corner dragged to (px, py) and the opposite corner fixed. The corner stops at
 * the photo's edges and never comes closer than `min` to the fixed corner (it never flips over).
 */
export function resizeCorner(r: CropRect, corner: CropCorner, px: number, py: number, min: number = MIN_CROP): CropRect {
  const c = clampCrop(r, min);
  const left = isLeft(corner);
  const top = isTop(corner);
  const ax = left ? c.x + c.width : c.x;
  const ay = top ? c.y + c.height : c.y;
  const x = left ? clamp(finite(px, c.x), 0, ax - min) : clamp(finite(px, ax + c.width), ax + min, 1);
  const y = top ? clamp(finite(py, c.y), 0, ay - min) : clamp(finite(py, ay + c.height), ay + min, 1);
  return clampCrop({ x: Math.min(ax, x), y: Math.min(ay, y), width: Math.abs(x - ax), height: Math.abs(y - ay) }, min);
}

/**
 * A new selection drawn from the press point (ax, ay) to (bx, by), at least `min` on each side in the
 * direction of the drag (shifted back inside when the press was close to an edge).
 */
export function cropFromPoints(ax: number, ay: number, bx: number, by: number, min: number = MIN_CROP): CropRect {
  const x0 = clamp(finite(ax, 0), 0, 1);
  const y0 = clamp(finite(ay, 0), 0, 1);
  const x1 = clamp(finite(bx, x0), 0, 1);
  const y1 = clamp(finite(by, y0), 0, 1);
  const width = Math.max(min, Math.abs(x1 - x0));
  const height = Math.max(min, Math.abs(y1 - y0));
  return clampCrop({ x: x1 < x0 ? x0 - width : x0, y: y1 < y0 ? y0 - height : y0, width, height }, min);
}

/** One arrow-key step: the whole selection, or one corner. */
export function nudgeCrop(r: CropRect, target: 'move' | CropCorner, dx: number, dy: number, min: number = MIN_CROP): CropRect {
  if (target === 'move') return moveCrop(r, dx, dy);
  const p = cornerPoint(clampCrop(r, min), target);
  return resizeCorner(r, target, p.x + dx, p.y + dy, min);
}

/** The arrow key's direction, or null for any other key. */
export function arrowDelta(key: string, big: boolean): { dx: number; dy: number } | null {
  const s = big ? NUDGE_BIG : NUDGE;
  switch (key) {
    case 'ArrowLeft':
      return { dx: -s, dy: 0 };
    case 'ArrowRight':
      return { dx: s, dy: 0 };
    case 'ArrowUp':
      return { dx: 0, dy: -s };
    case 'ArrowDown':
      return { dx: 0, dy: s };
    default:
      return null;
  }
}

export interface PixelRegion {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * The crop in whole source pixels of a `width` × `height` image, always inside it and at least 1 px on
 * each side. No crop (or the whole photo) is the whole image.
 */
export function cropToPixels(r: CropRect | null | undefined, width: number, height: number): PixelRegion {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (!r || isFullCrop(r)) return { sx: 0, sy: 0, sw: w, sh: h };
  const c = clampCrop(r, 0);
  const sx = clamp(Math.round(c.x * w), 0, w - 1);
  const sy = clamp(Math.round(c.y * h), 0, h - 1);
  const ex = clamp(Math.round((c.x + c.width) * w), sx + 1, w);
  const ey = clamp(Math.round((c.y + c.height) * h), sy + 1, h);
  return { sx, sy, sw: ex - sx, sh: ey - sy };
}

/** "72 by 60 percent" for the screen-reader announcement after a keyboard step. */
export function describeCrop(r: CropRect): string {
  if (isFullCrop(r)) return 'Whole photo';
  return `Cropped to ${Math.round(r.width * 100)} by ${Math.round(r.height * 100)} percent of the photo`;
}
