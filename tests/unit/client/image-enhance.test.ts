// On-device photo cleanup (lib/client/image-enhance.ts, design/DECISIONS.md v2.2 #10): auto levels, the
// unsharp mask, the measurements that decide whether either runs, and the time-sliced runner. Small
// synthetic RGBA images only.
import { describe, expect, it } from 'vitest';
import {
  EnhanceTimeout,
  LEVELS_WHITE,
  SHARPEN_KERNEL,
  SHARPEN_KERNEL_SUM,
  SHARPEN_LIMIT,
  SHARPEN_MAX_AMOUNT,
  SHARP_RATIO,
  SOFT_RATIO,
  analyzeSteps,
  applySteps,
  enhanceSteps,
  histogramPercentile,
  levelsLut,
  luma,
  planFor,
  runSliced,
  runSync,
  sharpenAmount,
  type Pixels,
} from '@/lib/client/image-enhance';

type Rgb = readonly [number, number, number];

function image(width: number, height: number, at: (x: number, y: number) => Rgb): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = at(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
}

const grey = (v: number): Rgb => [v, v, v];
const copy = (px: Pixels): Pixels => ({ data: new Uint8ClampedArray(px.data), width: px.width, height: px.height });
const at = (px: Pixels, x: number, y: number): Rgb => {
  const o = (y * px.width + x) * 4;
  return [px.data[o] as number, px.data[o + 1] as number, px.data[o + 2] as number];
};

function analyze(px: Pixels) {
  return runSync(analyzeSteps(px, new Uint8Array(px.width * px.height)));
}

/** Runs the whole cleanup on a copy and returns it with the result. */
function enhanced(px: Pixels) {
  const out = copy(px);
  const result = runSync(enhanceSteps(out));
  return { out, result };
}

function channelRange(px: Pixels): { min: number; max: number } {
  let min = 255;
  let max = 0;
  for (let i = 0; i < px.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const v = px.data[i + c] as number;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max };
}

/** A soft vertical edge from `a` to `b` over `width` pixels, centred. */
const softEdge = (w: number, h: number, a: number, b: number, width: number) =>
  image(w, h, (x) => {
    const t = Math.min(1, Math.max(0, (x - (w / 2 - width / 2)) / width));
    return grey(Math.round(a + (b - a) * t));
  });

/** Sharp-edged blocks (8 px checkerboard), the kind of detail a sharp photo has everywhere. */
const blocks = (w: number, h: number, a: number, b: number) => image(w, h, (x, y) => grey(((x >> 3) + (y >> 3)) % 2 ? b : a));

/** The same blocks after a 5×5 box blur (an out-of-focus photo of a screen). */
function blurred(px: Pixels, r: number): Pixels {
  const { width: w, height: h } = px;
  return image(w, h, (x, y) => {
    let sum = 0;
    let n = 0;
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        const xx = Math.min(w - 1, Math.max(0, x + dx));
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        sum += px.data[(yy * w + xx) * 4] as number;
        n += 1;
      }
    }
    return grey(Math.round(sum / n));
  });
}

describe('luma and histogram percentiles', () => {
  it('uses Rec. 601 weights in 8 bits', () => {
    expect(luma(0, 0, 0)).toBe(0);
    expect(luma(255, 255, 255)).toBe(255);
    expect(luma(255, 0, 0)).toBe(77);
    expect(luma(0, 255, 0)).toBe(149);
  });

  it('finds the value past a fraction of the samples', () => {
    const hist = new Uint32Array(256);
    hist[10] = 4;
    hist[100] = 992;
    hist[250] = 4;
    // 0.4 % at each end is clipped away; at 0.3 % / 99.7 % they are inside.
    expect(histogramPercentile(hist, 1000, 0.005)).toBe(100);
    expect(histogramPercentile(hist, 1000, 0.995)).toBe(100);
    expect(histogramPercentile(hist, 1000, 0.003)).toBe(10);
    expect(histogramPercentile(hist, 1000, 0.997)).toBe(250);
  });
});

describe('auto levels', () => {
  it('stretches a washed-out photo (glare on a phone screen), capped at 1.5×', () => {
    const px = image(100, 40, (x) => grey(60 + Math.round((130 * x) / 99)));
    const a = analyze(px);
    expect([a.low, a.high]).toEqual([60, 190]);
    const { out, result } = enhanced(px);
    expect(result.applied).toBe(true);
    const r = channelRange(out);
    expect(r.max - r.min).toBeGreaterThanOrEqual(Math.floor(130 * 1.5) - 1);
    expect(r.max - r.min).toBeLessThanOrEqual(Math.ceil(130 * 1.5) + 1);
    // Capped: the stretch keeps its place in the range instead of hitting either end.
    expect(r.min).toBeGreaterThan(0);
    expect(r.max).toBeLessThan(255);
  });

  it('clips at most 0.5 % at either end: a few specular highlights and black pixels do not count', () => {
    // 2000 px: 6 pure black and 6 pure white (0.3 % each), the rest 100–150.
    const px = image(200, 10, (x, y) => {
      const i = y * 200 + x;
      if (i < 6) return grey(0);
      if (i >= 1994) return grey(255);
      return grey(100 + (i % 51));
    });
    const a = analyze(px);
    expect(a.low).toBe(100);
    expect(a.high).toBe(150);
    // At 1 % each they are part of the photo's range.
    const wide = image(200, 10, (x, y) => {
      const i = y * 200 + x;
      if (i < 20) return grey(0);
      if (i >= 1980) return grey(255);
      return grey(100 + (i % 51));
    });
    expect(analyze(wide)).toMatchObject({ low: 0, high: 255 });
  });

  it('leaves a well-exposed photo alone', () => {
    expect(levelsLut(0, 255)).toBeNull();
    expect(levelsLut(5, 250)).toBeNull();
    expect(levelsLut(12, 249)).toBeNull();
    const px = image(64, 64, (x, y) => [(x * 4) % 256, (y * 4) % 256, ((x + y) * 2) % 256]);
    const { out, result } = enhanced(px);
    expect(result.plan.lut).toBeNull();
    expect(out.data).toEqual(px.data);
  });

  it('never blows out skin tones: the brightest channel sets the white point, and it stops at 248', () => {
    // A face filling most of the frame (R 230, G 185, B 160) on a dim background.
    const skin: Rgb = [230, 185, 160];
    const px = image(80, 80, (x, y) => ((x - 40) ** 2 + (y - 40) ** 2 < 32 ** 2 ? skin : [40 + (x % 3), 42, 45]));
    const a = analyze(px);
    expect(a.high).toBe(230);
    const { out, result } = enhanced(px);
    expect(result.plan.lut).not.toBeNull();
    const [r, g, b] = at(out, 40, 40);
    expect(r).toBeLessThanOrEqual(LEVELS_WHITE);
    expect(r).toBeGreaterThan(skin[0]);
    // One map for every channel: the skin keeps its order and stays well below clipping.
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(channelRange(out).max).toBeLessThan(255);
  });

  it('keeps a dark photo dark (blacks never lift) and a bright one bright (whites never dim)', () => {
    const dark = levelsLut(0, 120);
    expect(dark).not.toBeNull();
    expect(dark?.[0]).toBe(0);
    expect(dark?.[120]).toBe(180);
    const bright = levelsLut(150, 250);
    expect(bright).not.toBeNull();
    expect(bright?.[250]).toBe(250);
    expect(bright?.[150]).toBe(100);
  });
});

describe('unsharp mask', () => {
  it('uses a symmetric 5-tap binomial kernel that sums to 16', () => {
    expect(SHARPEN_KERNEL).toEqual([1, 4, 6, 4, 1]);
    expect(SHARPEN_KERNEL.reduce((a, b) => a + b, 0)).toBe(SHARPEN_KERNEL_SUM);
    expect([...SHARPEN_KERNEL].reverse()).toEqual([...SHARPEN_KERNEL]);
  });

  it('scales the amount by how soft the photo measures', () => {
    expect(sharpenAmount(SHARP_RATIO)).toBe(0);
    expect(sharpenAmount(0.8)).toBe(0);
    expect(sharpenAmount(Infinity)).toBe(0);
    expect(sharpenAmount(SOFT_RATIO)).toBe(SHARPEN_MAX_AMOUNT);
    expect(sharpenAmount(0.1)).toBe(SHARPEN_MAX_AMOUNT);
    const mid = sharpenAmount((SHARP_RATIO + SOFT_RATIO) / 2);
    expect(mid).toBeCloseTo(SHARPEN_MAX_AMOUNT / 2, 6);
    expect(sharpenAmount(0.35)).toBeGreaterThan(sharpenAmount(0.45));
  });

  it('measures sharp detail as sharp and the same detail out of focus as soft', () => {
    const sharp = blocks(96, 96, 40, 200);
    const soft = blurred(sharp, 2);
    expect(analyze(sharp).ratio).toBeGreaterThan(SHARP_RATIO);
    expect(analyze(soft).ratio).toBeLessThan(SOFT_RATIO + 0.1);
    expect(planFor(analyze(sharp)).amount).toBe(0);
    expect(planFor(analyze(soft)).amount).toBeGreaterThan(SHARPEN_MAX_AMOUNT * 0.75);
  });

  it('adds contrast across a soft edge and leaves flat areas as they are', () => {
    const px = softEdge(64, 8, 60, 200, 6);
    const out = copy(px);
    const y8 = new Uint8Array(64 * 8);
    runSync(analyzeSteps(out, y8));
    runSync(applySteps(out, y8, { lut: null, amount: SHARPEN_MAX_AMOUNT }));
    const before = (x: number) => at(px, x, 4)[0];
    const after = (x: number) => at(out, x, 4)[0];
    // The ramp runs from x = 29 to 35: its dark foot gets darker, its bright shoulder brighter.
    expect(after(29)).toBeLessThan(before(29));
    expect(after(35)).toBeGreaterThan(before(35));
    // Far from the edge: untouched.
    expect(after(4)).toBe(before(4));
    expect(after(60)).toBe(before(60));
  });

  it('ignores noise at or below the threshold (no amplified grain or screen texture)', () => {
    const px = image(48, 48, (x, y) => grey(128 + (((x * 7 + y * 13) % 3) - 1)));
    const out = copy(px);
    const y8 = new Uint8Array(48 * 48);
    runSync(analyzeSteps(out, y8));
    runSync(applySteps(out, y8, { lut: null, amount: SHARPEN_MAX_AMOUNT }));
    expect(out.data).toEqual(px.data);
  });

  it('changes no pixel by more than the limit (no halos along the bezel)', () => {
    const px = image(40, 8, (x) => grey(x < 20 ? 0 : 255));
    const out = copy(px);
    const y8 = new Uint8Array(40 * 8);
    runSync(analyzeSteps(out, y8));
    runSync(applySteps(out, y8, { lut: null, amount: 5 }));
    for (let i = 0; i < out.data.length; i += 4) {
      expect(Math.abs((out.data[i] as number) - (px.data[i] as number))).toBeLessThanOrEqual(SHARPEN_LIMIT);
    }
  });
});

describe('the whole cleanup', () => {
  it('does nothing to a sharp, well-exposed photo', () => {
    const px = blocks(96, 64, 0, 255);
    const { out, result } = enhanced(px);
    expect(result.applied).toBe(false);
    expect(out.data).toEqual(px.data);
  });

  it('does nothing to a flat image (a blank screen)', () => {
    const px = image(32, 32, () => grey(90));
    const { out, result } = enhanced(px);
    expect(result.analysis.ratio).toBe(Infinity);
    expect(result.applied).toBe(false);
    expect(out.data).toEqual(px.data);
  });

  it('cleans up a soft, washed-out photo of a screen: wider range and crisper edges', () => {
    const px = blurred(blocks(96, 96, 80, 170), 2);
    const { out, result } = enhanced(px);
    expect(result.applied).toBe(true);
    expect(result.plan.lut).not.toBeNull();
    expect(result.plan.amount).toBeGreaterThan(0);
    const r0 = channelRange(px);
    const r1 = channelRange(out);
    expect(r1.max - r1.min).toBeGreaterThan(r0.max - r0.min);
    expect(analyze(out).ratio).toBeGreaterThan(analyze(px).ratio);
  });

  it('gives the same pixels whatever the band size (time slicing changes nothing)', () => {
    const px = blurred(blocks(70, 53, 70, 180), 2);
    const a = copy(px);
    const b = copy(px);
    runSync(enhanceSteps(a, 64));
    runSync(enhanceSteps(b, 7));
    expect(b.data).toEqual(a.data);
  });
});

describe('time-sliced runner', () => {
  function* steps(n: number): Generator<void, string, void> {
    for (let i = 0; i < n; i += 1) yield;
    return 'done';
  }

  it('yields to the page once a slice is used up, and returns the result', async () => {
    let t = 0;
    let yields = 0;
    const result = await runSliced(steps(10), {
      now: () => (t += 5),
      deadline: 10_000,
      sliceMs: 12,
      yieldToMain: async () => {
        yields += 1;
      },
    });
    expect(result).toBe('done');
    expect(yields).toBeGreaterThanOrEqual(3);
  });

  it('gives up past the deadline with EnhanceTimeout', async () => {
    let t = 0;
    await expect(
      runSliced(steps(100), { now: () => (t += 50), deadline: 400, sliceMs: 12, yieldToMain: async () => {} }),
    ).rejects.toBeInstanceOf(EnhanceTimeout);
  });
});
