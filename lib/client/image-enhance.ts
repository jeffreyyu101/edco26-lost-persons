// On-device photo cleanup (design/DECISIONS.md v2.2 #10; Jeffrey, 2026-11-06 15:13: staff photograph a
// friend's phone screen showing the missing person). Pure pixel math on the already downscaled image
// (≤ 1600 px long edge), written as generators so lib/client/image.ts can run it in short time slices and
// give up at a deadline. Part of the photo chunk (lazy), so it never weighs on the first load.
//
// Conservative by design: it only acts on what it measures, and a well-exposed, sharp photo is left alone.
//   * Levels. Black and white points at 0.5 % / 99.5 % of the darkest / brightest channel of each pixel, so
//     at most 0.5 % of pixels clip at either end and no channel of a skin tone is pushed past the white
//     point. One linear map for R, G and B (no colour shift); the stretch is capped at 1.5×, a capped
//     stretch keeps the photo's place in the tonal range (a dark photo is not lifted to grey, a bright one
//     is not dimmed), and the white point is never stretched past 248. A photo whose tones would move by
//     16 levels or less (already well exposed) is left as it is.
//   * Unsharp mask on luminance, after the resize: a 5-tap binomial blur (σ ≈ 1 px), an amount from 0 to
//     0.5 by how soft the photo measures (lap/grad ratio below; a sharp photo gets none), a 2-level
//     threshold so noise and leftover screen texture are not amplified, and a ±20 limit so hard edges (the
//     phone's bezel) get no halos.

/** RGBA pixels (ImageData, or a plain object in tests). */
export interface Pixels {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** Fraction clipped at each end of the histogram. */
export const LEVELS_CLIP = 0.005;
/** The strongest contrast stretch. */
export const LEVELS_MAX_GAIN = 1.5;
/** A stretch never moves the white point above this (headroom for skin highlights). */
export const LEVELS_WHITE = 248;
/** Levels are skipped when no tone in the photo's range would move by more than this. */
export const LEVELS_MIN_CHANGE = 16;

/** The blur of the unsharp mask: 5-tap binomial, separable (sum 16 per pass). */
export const SHARPEN_KERNEL = [1, 4, 6, 4, 1] as const;
export const SHARPEN_KERNEL_SUM = 16;
/** The most sharpening, for a clearly soft photo. */
export const SHARPEN_MAX_AMOUNT = 0.5;
/** Luma detail at or below this many levels is left as it is. */
export const SHARPEN_THRESHOLD = 2;
/** The largest change sharpening may make to a pixel. */
export const SHARPEN_LIMIT = 20;
/**
 * Softness from the lap/grad ratio (analyzeSteps): a step edge measures about 1, an edge blurred over W
 * pixels about 1 / W. At or above SHARP_RATIO nothing is sharpened; at or below SOFT_RATIO the full
 * amount. Calibrated on 42 sample photos: sharp 0.38–0.85 (most 0.55–0.77), the same blurred by σ = 1 px
 * 0.26–0.48, by σ ≥ 1.5 px at most 0.38.
 */
export const SHARP_RATIO = 0.5;
export const SOFT_RATIO = 0.3;
/** Below this mean gradient per sample the photo is flat (a blank screen): nothing to sharpen. */
export const FLAT_GRADIENT = 0.75;

/** Rec. 601 luma in 8 bits (weights 77 + 150 + 29 = 256). */
export function luma(r: number, g: number, b: number): number {
  return (77 * r + 150 * g + 29 * b + 128) >> 8;
}

/** The lowest value v with more than `fraction` of the samples at or below v. */
export function histogramPercentile(hist: ArrayLike<number>, total: number, fraction: number): number {
  const target = fraction * total;
  let seen = 0;
  for (let v = 0; v < hist.length; v += 1) {
    seen += hist[v] as number;
    if (seen > target) return v;
  }
  return hist.length - 1;
}

/**
 * The levels map for black point `low` and white point `high`, or null when it would barely change
 * anything (a well-exposed photo).
 */
export function levelsLut(low: number, high: number, maxGain: number = LEVELS_MAX_GAIN): Uint8Array | null {
  if (!(high > low)) return null;
  const range = high - low;
  const top = Math.max(high, LEVELS_WHITE);
  const gain = Math.min(maxGain, top / range);
  const outRange = range * gain;
  // Uncapped, the range fills [0, top]. Capped, it keeps its place in it, so blacks never lift and the
  // white point never drops.
  const slack = top - range;
  const outLow = slack > 0 ? (low * (top - outRange)) / slack : 0;
  const lut = new Uint8Array(256);
  let moved = 0;
  for (let v = 0; v < 256; v += 1) {
    const out = Math.min(255, Math.max(0, Math.round(outLow + (v - low) * gain)));
    lut[v] = out;
    if (v >= low && v <= high) moved = Math.max(moved, Math.abs(out - v));
  }
  return moved > LEVELS_MIN_CHANGE ? lut : null;
}

/** How much to sharpen for a measured lap/grad ratio (0 for a sharp photo). */
export function sharpenAmount(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio >= SHARP_RATIO) return 0;
  if (ratio <= SOFT_RATIO) return SHARPEN_MAX_AMOUNT;
  return (SHARPEN_MAX_AMOUNT * (SHARP_RATIO - ratio)) / (SHARP_RATIO - SOFT_RATIO);
}

export interface Analysis {
  /** Black and white points (0.5 % / 99.5 % of the darkest / brightest channel). */
  low: number;
  high: number;
  /** Sum of |second differences| / sum of |first differences| of luma (both sides); Infinity when flat. */
  ratio: number;
}

export interface EnhancePlan {
  lut: Uint8Array | null;
  amount: number;
}

export interface EnhanceResult {
  applied: boolean;
  analysis: Analysis;
  plan: EnhancePlan;
}

export const planIsNoop = (p: EnhancePlan) => !p.lut && p.amount <= 0;

export function planFor(a: Analysis): EnhancePlan {
  return { lut: levelsLut(a.low, a.high), amount: sharpenAmount(a.ratio) };
}

/** Rows handled between two yields (about 100k pixels at 1600 px wide). */
export const BAND_ROWS = 64;

/**
 * Pass 1: the luma plane and the darkest / brightest channel histograms. Pass 2: the sharpness ratio on
 * every second pixel of every second row, away from the border.
 */
export function* analyzeSteps(px: Pixels, y8: Uint8Array, band: number = BAND_ROWS): Generator<void, Analysis, void> {
  const { data, width: w, height: h } = px;
  const minHist = new Uint32Array(256);
  const maxHist = new Uint32Array(256);
  for (let y0 = 0; y0 < h; y0 += band) {
    const y1 = Math.min(h, y0 + band);
    for (let i = y0 * w, end = y1 * w; i < end; i += 1) {
      const o = i * 4;
      const r = data[o] as number;
      const g = data[o + 1] as number;
      const b = data[o + 2] as number;
      y8[i] = (77 * r + 150 * g + 29 * b + 128) >> 8;
      const lo = r < g ? (r < b ? r : b) : g < b ? g : b;
      const hi = r > g ? (r > b ? r : b) : g > b ? g : b;
      minHist[lo] = (minHist[lo] as number) + 1;
      maxHist[hi] = (maxHist[hi] as number) + 1;
    }
    yield;
  }
  const total = w * h;
  const low = histogramPercentile(minHist, total, LEVELS_CLIP);
  const high = histogramPercentile(maxHist, total, 1 - LEVELS_CLIP);

  let lap = 0;
  let grad = 0;
  let samples = 0;
  for (let y0 = 1; y0 < h - 1; y0 += band) {
    const y1 = Math.min(h - 1, y0 + band);
    for (let y = y0; y < y1; y += 2) {
      const row = y * w;
      for (let x = 1; x < w - 1; x += 2) {
        const i = row + x;
        const c = y8[i] as number;
        const l = y8[i - 1] as number;
        const r = y8[i + 1] as number;
        const u = y8[i - w] as number;
        const d = y8[i + w] as number;
        lap += Math.abs(l + r - 2 * c) + Math.abs(u + d - 2 * c);
        // Both neighbours, so an edge counts the same whichever side of it the sample falls on.
        grad += Math.abs(r - c) + Math.abs(c - l) + Math.abs(d - c) + Math.abs(c - u);
        samples += 1;
      }
    }
    yield;
  }
  const ratio = samples === 0 || grad / samples < FLAT_GRADIENT ? Infinity : lap / grad;
  return { low, high, ratio };
}

/** Applies the plan to `px` in place (levels on R, G, B; then the luma unsharp mask). */
export function* applySteps(px: Pixels, y8: Uint8Array, plan: EnhancePlan, band: number = BAND_ROWS): Generator<void, void, void> {
  const { data, width: w, height: h } = px;
  const lut = plan.lut;
  if (lut) {
    for (let y0 = 0; y0 < h; y0 += band) {
      const end = Math.min(h, y0 + band) * w;
      for (let i = y0 * w; i < end; i += 1) {
        const o = i * 4;
        data[o] = lut[data[o] as number] as number;
        data[o + 1] = lut[data[o + 1] as number] as number;
        data[o + 2] = lut[data[o + 2] as number] as number;
        // Luma of the mapped pixel: the map is affine and the weights sum to 1, so lut[luma] is the luma
        // of the mapped colour (except where a channel clipped, which sharpening can live with).
        y8[i] = lut[y8[i] as number] as number;
      }
      yield;
    }
  }
  if (plan.amount <= 0) return;

  const [k0, k1, k2] = [SHARPEN_KERNEL[0], SHARPEN_KERNEL[1], SHARPEN_KERNEL[2]];
  const norm = SHARPEN_KERNEL_SUM * SHARPEN_KERNEL_SUM;
  // Horizontal pass (border pixels repeat).
  const hsum = new Uint16Array(w * h);
  for (let y0 = 0; y0 < h; y0 += band) {
    const y1 = Math.min(h, y0 + band);
    for (let y = y0; y < y1; y += 1) {
      const row = y * w;
      for (let x = 0; x < w; x += 1) {
        const xm2 = row + (x >= 2 ? x - 2 : 0);
        const xm1 = row + (x >= 1 ? x - 1 : 0);
        const xp1 = row + (x + 1 < w ? x + 1 : w - 1);
        const xp2 = row + (x + 2 < w ? x + 2 : w - 1);
        hsum[row + x] =
          k0 * ((y8[xm2] as number) + (y8[xp2] as number)) + k1 * ((y8[xm1] as number) + (y8[xp1] as number)) + k2 * (y8[row + x] as number);
      }
    }
    yield;
  }
  // Vertical pass, then detail = luma − blur, thresholded, scaled, limited, added to R, G and B.
  const amount = plan.amount;
  const t = SHARPEN_THRESHOLD;
  const limit = SHARPEN_LIMIT;
  for (let y0 = 0; y0 < h; y0 += band) {
    const y1 = Math.min(h, y0 + band);
    for (let y = y0; y < y1; y += 1) {
      const rm2 = (y >= 2 ? y - 2 : 0) * w;
      const rm1 = (y >= 1 ? y - 1 : 0) * w;
      const r0 = y * w;
      const rp1 = (y + 1 < h ? y + 1 : h - 1) * w;
      const rp2 = (y + 2 < h ? y + 2 : h - 1) * w;
      for (let x = 0; x < w; x += 1) {
        const blur =
          (k0 * ((hsum[rm2 + x] as number) + (hsum[rp2 + x] as number)) +
            k1 * ((hsum[rm1 + x] as number) + (hsum[rp1 + x] as number)) +
            k2 * (hsum[r0 + x] as number)) /
          norm;
        let detail = (y8[r0 + x] as number) - blur;
        if (detail > t) detail -= t;
        else if (detail < -t) detail += t;
        else continue;
        let delta = amount * detail;
        if (delta > limit) delta = limit;
        else if (delta < -limit) delta = -limit;
        const o = (r0 + x) * 4;
        // Uint8ClampedArray rounds and clamps to 0..255.
        data[o] = (data[o] as number) + delta;
        data[o + 1] = (data[o + 1] as number) + delta;
        data[o + 2] = (data[o + 2] as number) + delta;
      }
    }
    yield;
  }
}

/** Measure, decide, and (when the plan does something) apply, in place. */
export function* enhanceSteps(px: Pixels, band: number = BAND_ROWS): Generator<void, EnhanceResult, void> {
  const y8 = new Uint8Array(px.width * px.height);
  const analysis = yield* analyzeSteps(px, y8, band);
  const plan = planFor(analysis);
  if (planIsNoop(plan)) return { applied: false, analysis, plan };
  yield* applySteps(px, y8, plan, band);
  return { applied: true, analysis, plan };
}

/** Runs a step generator to the end at once (tests, and anything off the main thread). */
export function runSync<T>(gen: Generator<void, T, void>): T {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

export class EnhanceTimeout extends Error {
  constructor() {
    super('photo cleanup ran out of time');
    this.name = 'EnhanceTimeout';
  }
}

export interface SliceOptions {
  /** Clock in ms (performance.now in the browser). */
  now: () => number;
  /** Give up (EnhanceTimeout) once the clock passes this. */
  deadline: number;
  /** Yield to the page after this long without a break. */
  sliceMs: number;
  /** Lets the page handle input and paint. */
  yieldToMain: () => Promise<void>;
}

/** Runs a step generator in time slices; throws EnhanceTimeout past the deadline. */
export async function runSliced<T>(gen: Generator<void, T, void>, o: SliceOptions): Promise<T> {
  let sliceStart = o.now();
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    const t = o.now();
    if (t > o.deadline) {
      gen.return(undefined as T);
      throw new EnhanceTimeout();
    }
    if (t - sliceStart >= o.sliceMs) {
      await o.yieldToMain();
      sliceStart = o.now();
    }
  }
}
