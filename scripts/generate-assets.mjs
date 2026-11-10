// Generates the PWA icons and the synthetic seed photos by rendering small HTML pages in headless
// Chromium (no canvas dependency). Re-run after changing a logo:
//
//   node scripts/generate-assets.mjs
//
// Outputs (committed):
//   public/icons/icon-192.png, icon-512.png   maskable, the Ground Control logo inside the 80% safe zone
//   public/icons/apple-touch-icon.png         180×180
//   public/icons/favicon-32.png               the Ground Control "O" (its target mark)
//   public/logos/ground-control.png           copied from design/
// (Events) Ground Control only: no event's logo is in the build (an event's logo is uploaded in the app).
//   supabase/seed-photos/photo.jpg, photo_thumb.jpg    synthetic placeholder "photos" (no real person)
import { chromium } from '@playwright/test';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BG = '#111113'; // Radix gray-1 (dark)

const dataUrl = async (file) => `data:image/png;base64,${(await readFile(join(root, file))).toString('base64')}`;

async function main() {
  await mkdir(join(root, 'public/icons'), { recursive: true });
  await mkdir(join(root, 'public/logos'), { recursive: true });
  await mkdir(join(root, 'supabase/seed-photos'), { recursive: true });

  await copyFile(join(root, 'design/gc-logo.png'), join(root, 'public/logos/ground-control.png'));

  const gc = await dataUrl('design/gc-logo.png');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });

    // content: the fraction of the square the logo stack may use (maskable safe zone is a centred circle
    // of 80% diameter; 0.55 keeps the logo corners inside it).
    const icon = async (size, content, out) => {
      const w = Math.round(size * content);
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<!doctype html><html><body style="margin:0">
        <div style="width:${size}px;height:${size}px;background:${BG};display:flex;
                    align-items:center;justify-content:center">
          <img src="${gc}" style="width:${w}px">
        </div></body></html>`);
      await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
      await page.screenshot({ path: join(root, out), type: 'png', omitBackground: false });
    };

    await icon(512, 0.55, 'public/icons/icon-512.png');
    await icon(192, 0.55, 'public/icons/icon-192.png');
    await icon(180, 0.72, 'public/icons/apple-touch-icon.png');

    // Favicon: the whole Ground Control word would be illegible at 32 px; its target "O" (in GROUND) alone.
    await page.setViewportSize({ width: 32, height: 32 });
    await page.setContent(`<!doctype html><html><body style="margin:0">
      <div style="width:32px;height:32px;background:${BG};border-radius:6px;overflow:hidden;position:relative">
        <img src="${gc}" style="position:absolute;width:190px;left:-69px;top:0px"></div></body></html>`);
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
    await page.screenshot({ path: join(root, 'public/icons/favicon-32.png'), type: 'png', omitBackground: true });

    // Synthetic seed "photo": an abstract silhouette on a gradient. No real person, no EXIF.
    const photo = async (width, height, out, quality) => {
      await page.setViewportSize({ width, height });
      await page.setContent(`<!doctype html><html><body style="margin:0">
        <svg width="${width}" height="${height}" viewBox="0 0 30 40" preserveAspectRatio="xMidYMid slice"
             xmlns="http://www.w3.org/2000/svg">
          <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#3a3f58"/><stop offset="1" stop-color="#7a5c8f"/></linearGradient></defs>
          <rect width="30" height="40" fill="url(#g)"/>
          <circle cx="15" cy="15" r="6.5" fill="#c9c3d6"/>
          <path d="M2 44a13 12 0 0 1 26 0z" fill="#c9c3d6"/>
        </svg></body></html>`);
      await page.screenshot({ path: join(root, out), type: 'jpeg', quality });
    };
    await photo(600, 800, 'supabase/seed-photos/photo.jpg', 82);
    await photo(240, 320, 'supabase/seed-photos/photo_thumb.jpg', 70);
  } finally {
    await browser.close();
  }
  console.log('generate-assets: done');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
