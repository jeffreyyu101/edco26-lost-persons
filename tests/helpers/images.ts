// Synthetic image fixtures that real decoders accept (browsers, Playwright's trace snapshotter). Tests that
// upload photos use these, never a magic-byte prefix followed by junk: an undecodable object left in the
// shared local bucket shows up as a broken thumbnail in later e2e runs and manual QA.
export { syntheticPng } from '../e2e/helpers/png';

/** A 1×1 lossless WebP (the classic feature-detection image): RIFF size 26, one VP8L chunk. */
export const TINY_WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
