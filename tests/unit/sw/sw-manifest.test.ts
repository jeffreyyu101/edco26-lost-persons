// scripts/sw-manifest.mjs: `next build` lists every /_next/static file in public/sw-manifest.json, which an
// installing service worker caches in full (public/sw.js). Runs on a synthetic dist directory.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import nextConfig from '@/next.config';
import { writeSwManifest } from '@/scripts/sw-manifest.mjs';

let projectDir: string;
let distDir: string;

async function file(path: string, body = 'x') {
  const full = join(distDir, 'static', path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, body);
}

const written = async () => JSON.parse(await readFile(join(projectDir, 'public', 'sw-manifest.json'), 'utf8')) as { assets: string[] };

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'lp-sw-manifest-'));
  distDir = join(projectDir, '.next');
  await mkdir(join(projectDir, 'public'), { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('sw-manifest', () => {
  it('lists every static file the build serves (view chunks, CSS, fonts, build files), not source maps', async () => {
    await file('chunks/0shell.js');
    await file('chunks/0view-only-dynamic.js');
    await file('chunks/0view-only-dynamic.js.map');
    await file('chunks/app.css');
    await file('media/inter latin.woff2');
    await file('BUILD_ID_x/_buildManifest.js');

    const assets = await writeSwManifest({ projectDir, distDir });
    expect(assets).toEqual([
      '/_next/static/BUILD_ID_x/_buildManifest.js',
      '/_next/static/chunks/0shell.js',
      '/_next/static/chunks/0view-only-dynamic.js',
      '/_next/static/chunks/app.css',
      '/_next/static/media/inter%20latin.woff2',
    ]);
    expect(await written()).toEqual({ assets });
  });

  it('accepts the layout Vercel builds write (static/immutable/chunks, static/build-<id>)', async () => {
    await file('immutable/chunks/07_s943xsdled.js');
    await file('immutable/chunks/0_wgrunrnim_i.css');
    await file('build-TfctsWXpff2fKS/_buildManifest.js');

    const assets = await writeSwManifest({ projectDir, distDir });
    expect(assets).toEqual([
      '/_next/static/build-TfctsWXpff2fKS/_buildManifest.js',
      '/_next/static/immutable/chunks/07_s943xsdled.js',
      '/_next/static/immutable/chunks/0_wgrunrnim_i.css',
    ]);
  });

  it('fails the build when there are no client chunks', async () => {
    await file('media/inter.woff2');
    await expect(writeSwManifest({ projectDir, distDir })).rejects.toThrow(/no client chunks/);
  });

  it('runs after every production compile (next.config.ts)', async () => {
    await file('chunks/0shell.js');
    const hook = nextConfig.compiler?.runAfterProductionCompile;
    expect(hook).toBeTypeOf('function');
    await hook!({ projectDir, distDir });
    expect((await written()).assets).toEqual(['/_next/static/chunks/0shell.js']);
  });
});
