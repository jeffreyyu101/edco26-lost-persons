// The build's static asset list for the service worker (public/sw.js).
//
// A new worker must cache the WHOLE new build before it may offer "Update ready · Reload": the shell's HTML
// names only its own scripts, never the view chunks next/dynamic loads later, and an update that activates
// without them leaves the new shell unable to open its views offline. So every production build lists every
// file it serves under /_next/static/ in public/sw-manifest.json, and the installing worker caches all of it.
//
// next.config.ts runs this as `compiler.runAfterProductionCompile`, so plain `next build` (Vercel,
// `npm run build`, `npm run build:test`) always writes it, after the client chunks exist. The output is
// generated (gitignored). By hand: `node scripts/sw-manifest.mjs [projectDir]` after `next build`.
import { readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SW_MANIFEST_FILE = 'sw-manifest.json';
export const STATIC_URL_PREFIX = '/_next/static/';

/** `/_next/static/...` URLs for every file under `<distDir>/static` (source maps excluded), sorted. */
export async function staticAssetUrls(distDir) {
  const root = join(distDir, 'static');
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && !e.name.endsWith('.map'))
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).map(encodeURIComponent).join('/'))
    .map((path) => `${STATIC_URL_PREFIX}${path}`)
    .sort();
}

/**
 * Writes `<projectDir>/public/sw-manifest.json` = `{"assets": [...]}` and returns the asset list. Fails the
 * build when there are no chunks: a worker given an empty list could not cache the build.
 */
export async function writeSwManifest({ projectDir, distDir }) {
  const assets = await staticAssetUrls(distDir);
  if (!assets.some((u) => u.startsWith(`${STATIC_URL_PREFIX}chunks/`))) {
    throw new Error(`sw-manifest: no client chunks under ${join(distDir, 'static')}`);
  }
  await writeFile(join(projectDir, 'public', SW_MANIFEST_FILE), `${JSON.stringify({ assets })}\n`);
  return assets;
}

// No top-level await: next.config.ts (compiled to CommonJS) loads this module with require().
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectDir = resolve(process.argv[2] ?? '.');
  writeSwManifest({ projectDir, distDir: join(projectDir, '.next') }).then(
    (assets) => console.log(`public/${SW_MANIFEST_FILE}: ${assets.length} assets`),
    (error) => {
      console.error(String(error instanceof Error ? error.message : error));
      process.exitCode = 1;
    },
  );
}
