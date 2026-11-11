import { deflateSync } from 'node:zlib';

/**
 * A small, decodable synthetic PNG (a vertical two-colour gradient), so the store's canvas compression
 * really runs on it. Synthetic test data only.
 */
export function syntheticPng(width = 120, height = 160): Buffer {
  return pngFrom(width, height, (x, y) => {
    const t = y / height;
    return [Math.round(230 * (1 - t) + 40 * t), Math.round(120 * (1 - t) + 40 * t), Math.round(170 * (1 - t) + 60 * t)];
  });
}

/**
 * (Phase 3) A synthetic PNG with an alpha channel: `pixel(x, y)` → [r, g, b, a]. For the event logo tests (a
 * single-colour transparent logo vs. a coloured opaque one).
 */
export function rgbaPng(width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number, number]): Buffer {
  return pngFrom(width, height, pixel, true);
}

function pngFrom(width: number, height: number, pixel: (x: number, y: number) => readonly number[], alpha = false): Buffer {
  const bpp = alpha ? 4 : 3;
  const raw = Buffer.alloc((width * bpp + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * bpp + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const px = pixel(x, y);
      for (let k = 0; k < bpp; k += 1) raw[row + 1 + x * bpp + k] = px[k] ?? 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
