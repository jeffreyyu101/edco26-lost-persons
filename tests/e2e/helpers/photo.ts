// Photo helpers for the e2e specs (design/DECISIONS.md v2.2 #10). Synthetic data only.
//   confirmCrop(page)        the one tap that keeps a picked photo whole ("Use photo" in the crop step)
//   confirmCrops(page, n)    the same for each of n photos picked together ("1 of n" … "n of n")
//   screenPhotoJpeg(page)    a 12 MP "photo of a friend's phone screen": a dim venue, the phone and its
//                            bezel, and on its screen a soft, washed-out portrait (glare veil, pixel grid,
//                            sensor noise). Rendered by the browser as JPEG, then given an EXIF block with
//                            camera, orientation and GPS tags, the way a phone camera writes it.
//   jpegInfo(bytes)          size, EXIF / GPS presence and pixel size, read from the JPEG markers
import { expect, type Page } from '@playwright/test';

/** Confirms the crop step without changing the selection (the whole photo). */
export async function confirmCrop(page: Page): Promise<void> {
  const step = page.getByRole('dialog', { name: 'Crop photo' });
  await expect(step).toBeVisible();
  await step.getByRole('button', { name: 'Use photo' }).click();
  await expect(step).toBeHidden();
}

/**
 * Keeps each of `n` photos picked together whole. The photo that takes over in the open step ignores a tap for
 * its first 350 ms (CropSheet FRESH_MS), so each later one waits that out first.
 */
export async function confirmCrops(page: Page, n: number): Promise<void> {
  const step = page.getByRole('dialog', { name: 'Crop photo' });
  for (let i = 1; i <= n; i += 1) {
    if (n > 1) await expect(step.getByText(`${i} of ${n}`, { exact: true })).toBeVisible();
    else await expect(step).toBeVisible();
    if (i > 1) await page.waitForTimeout(500);
    await step.getByRole('button', { name: 'Use photo' }).click();
  }
  await expect(step).toBeHidden();
}

/** Where the phone's screen is in the fixture, as fractions of the (displayed, upright) photo. */
export interface ScreenFixture {
  jpeg: Buffer;
  /** Pixel size as displayed (after EXIF orientation). */
  width: number;
  height: number;
  screen: { x: number; y: number; width: number; height: number };
}

/**
 * The fixture is drawn upright (portrait), stored rotated into landscape pixels and tagged Orientation 6
 * (rotate 90° clockwise to display), so the crop and the stored photo also prove that orientation is
 * honoured end to end.
 */
export async function screenPhotoJpeg(page: Page, size = { width: 3024, height: 4032 }): Promise<ScreenFixture> {
  const out = await page.evaluate(async ({ width, height }) => {
    const upright = document.createElement('canvas');
    upright.width = width;
    upright.height = height;
    const ctx = upright.getContext('2d') as CanvasRenderingContext2D;
    // A dim venue.
    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, '#2b2533');
    bg.addColorStop(0.6, '#3b3140');
    bg.addColorStop(1, '#17151b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(255,190,120,0.18)';
    for (let i = 0; i < 9; i += 1) {
      ctx.beginPath();
      ctx.arc(width * ((i * 0.37) % 1), height * ((i * 0.53) % 1), width * 0.06, 0, Math.PI * 2);
      ctx.fill();
    }
    // The phone.
    const pw = width * 0.58;
    const ph = pw * 2.05;
    const px = (width - pw) / 2;
    const py = (height - ph) / 2;
    ctx.fillStyle = '#0c0c0f';
    ctx.beginPath();
    ctx.roundRect(px, py, pw, ph, pw * 0.13);
    ctx.fill();
    const inset = pw * 0.045;
    const sx = Math.round(px + inset);
    const sy = Math.round(py + inset);
    const sw = Math.round(pw - inset * 2);
    const sh = Math.round(ph - inset * 2);
    // The photo on its screen: a small portrait, scaled up (soft).
    const small = document.createElement('canvas');
    small.width = 90;
    small.height = 195;
    const s = small.getContext('2d') as CanvasRenderingContext2D;
    const sky = s.createLinearGradient(0, 0, 0, 195);
    sky.addColorStop(0, '#6f8fb8');
    sky.addColorStop(1, '#c9a0b8');
    s.fillStyle = sky;
    s.fillRect(0, 0, 90, 195);
    s.fillStyle = '#d0507a'; // top
    s.beginPath();
    s.ellipse(45, 175, 40, 45, 0, 0, Math.PI * 2);
    s.fill();
    s.fillStyle = '#e3b597'; // face
    s.beginPath();
    s.ellipse(45, 95, 19, 25, 0, 0, Math.PI * 2);
    s.fill();
    s.fillStyle = '#3a2418'; // hair
    s.beginPath();
    s.ellipse(45, 80, 22, 18, 0, Math.PI, Math.PI * 2);
    s.fill();
    s.fillRect(23, 78, 6, 40);
    s.fillRect(61, 78, 6, 40);
    s.fillStyle = '#f0e2d0'; // hat
    s.fillRect(26, 58, 38, 7);
    s.fillStyle = '#222';
    s.fillRect(37, 92, 4, 2);
    s.fillRect(49, 92, 4, 2);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(small, sx, sy, sw, sh);
    // Glare (washed out) and the screen's pixel grid.
    ctx.fillStyle = 'rgba(235,235,245,0.24)';
    ctx.fillRect(sx, sy, sw, sh);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let y = sy; y < sy + sh; y += 3) ctx.fillRect(sx, y, sw, 1);
    for (let x = sx; x < sx + sw; x += 3) ctx.fillRect(x, sy, 1, sh);
    // Sensor noise.
    const img = ctx.getImageData(0, 0, width, height);
    let seed = 7;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = ((seed >> 16) % 13) - 6;
      img.data[i] = (img.data[i] as number) + n;
      img.data[i + 1] = (img.data[i + 1] as number) + n;
      img.data[i + 2] = (img.data[i + 2] as number) + n;
    }
    ctx.putImageData(img, 0, 0);
    // Stored as landscape pixels (rotated 90° counter-clockwise); EXIF Orientation 6 turns it back.
    const stored = document.createElement('canvas');
    stored.width = height;
    stored.height = width;
    const sctx = stored.getContext('2d') as CanvasRenderingContext2D;
    sctx.translate(0, width);
    sctx.rotate(-Math.PI / 2);
    sctx.drawImage(upright, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => stored.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', 0.92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    upright.width = 0;
    stored.width = 0;
    return { b64: btoa(bin), screen: { x: sx / width, y: sy / height, width: sw / width, height: sh / height } };
  }, size);
  return { jpeg: withExif(Buffer.from(out.b64, 'base64'), 6), width: size.width, height: size.height, screen: out.screen };
}

/** A minimal little-endian EXIF block: Make, Model, Orientation and a GPS IFD (latitude and longitude). */
export function exifSegment(orientation: number): Buffer {
  const make = Buffer.from('TESTCAM\0', 'ascii');
  const model = Buffer.from('SCREEN-PHOTO\0', 'ascii');
  const tiff = Buffer.alloc(186);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  const entry = (at: number, tag: number, type: number, count: number, value: number, inlineShort = false) => {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    if (inlineShort) tiff.writeUInt16LE(value, at + 8);
    else tiff.writeUInt32LE(value, at + 8);
  };
  // IFD0 at 8: 4 entries, data from 62.
  tiff.writeUInt16LE(4, 8);
  entry(10, 0x010f, 2, make.length, 62);
  entry(22, 0x0110, 2, model.length, 70);
  entry(34, 0x0112, 3, 1, orientation, true);
  entry(46, 0x8825, 4, 1, 84);
  tiff.writeUInt32LE(0, 58);
  make.copy(tiff, 62);
  model.copy(tiff, 70);
  // GPS IFD at 84: 4 entries, rationals from 138.
  tiff.writeUInt16LE(4, 84);
  entry(86, 0x0001, 2, 2, 0);
  tiff.write('N\0', 94, 'ascii');
  entry(98, 0x0002, 5, 3, 138);
  entry(110, 0x0003, 2, 2, 0);
  tiff.write('W\0', 118, 'ascii');
  entry(122, 0x0004, 5, 3, 162);
  tiff.writeUInt32LE(0, 134);
  [28, 1, 25, 1, 7, 1, 81, 1, 23, 1, 24, 1].forEach((v, i) => tiff.writeUInt32LE(v, 138 + i * 4));
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/** The JPEG with an EXIF APP1 right after SOI. */
export function withExif(jpeg: Buffer, orientation: number): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
  return Buffer.concat([jpeg.subarray(0, 2), exifSegment(orientation), jpeg.subarray(2)]);
}

export interface JpegInfo {
  bytes: number;
  isJpeg: boolean;
  /** An APP1 "Exif" segment, or the fixture's camera or GPS strings anywhere in the file. */
  hasExif: boolean;
  width: number;
  height: number;
}

export function jpegInfo(buf: Buffer): JpegInfo {
  const info: JpegInfo = { bytes: buf.length, isJpeg: buf[0] === 0xff && buf[1] === 0xd8, hasExif: false, width: 0, height: 0 };
  if (buf.includes(Buffer.from('Exif\0\0', 'ascii')) || buf.includes(Buffer.from('TESTCAM', 'ascii')) || buf.includes(Buffer.from('SCREEN-PHOTO', 'ascii'))) {
    info.hasExif = true;
  }
  let i = 2;
  while (info.isJpeg && i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1] as number;
    if (marker === 0xd9 || marker === 0xda) break;
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1 && buf.subarray(i + 4, i + 10).equals(Buffer.from('Exif\0\0', 'ascii'))) info.hasExif = true;
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      info.height = buf.readUInt16BE(i + 5);
      info.width = buf.readUInt16BE(i + 7);
    }
    i += 2 + len;
  }
  return info;
}
