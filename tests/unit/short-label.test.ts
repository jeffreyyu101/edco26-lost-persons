// (Events) The short name a post or team gets when Short is left empty: lib/short-label.ts.
import { describe, expect, it } from 'vitest';
import { deriveShort, effectiveShort } from '@/lib/short-label';

describe('deriveShort', () => {
  it('keeps a label that fits', () => {
    expect(deriveShort('Main Medical', 16)).toBe('Main Medical');
    expect(deriveShort('Gate A', 16)).toBe('Gate A');
    expect(deriveShort('x'.repeat(16), 16)).toBe('x'.repeat(16));
  });

  it('takes the part before the first separator', () => {
    expect(deriveShort('FA 1 – Main Stage', 16)).toBe('FA 1');
    expect(deriveShort('FA 2 — Vans Stage Medical', 16)).toBe('FA 2');
    expect(deriveShort('North Gate - Merch Tent', 16)).toBe('North Gate');
    expect(deriveShort('Beer Garden: West Side', 16)).toBe('Beer Garden');
    expect(deriveShort('Med Ops / Command Center', 16)).toBe('Med Ops');
    expect(deriveShort('Lost Kids (Family Tent)', 16)).toBe('Lost Kids');
    // The first separator in the text wins, whichever it is.
    expect(deriveShort('Stage 2 / East – Big Tent', 16)).toBe('Stage 2');
  });

  it('cuts at a word boundary when the leading part is too long or there is none', () => {
    expect(deriveShort('Ground Control Dispatch Team', 24)).toBe('Ground Control Dispatch');
    expect(deriveShort('Merch Tent Info Booth', 16)).toBe('Merch Tent Info');
    expect(deriveShort('Mainstage Medical Tent – North', 16)).toBe('Mainstage');
    expect(deriveShort('Medical Ops North Quadrant', 24)).toBe('Medical Ops North');
  });

  it('never ends with punctuation and never adds an ellipsis', () => {
    expect(deriveShort('Main Stage, North Side Tent', 16)).toBe('Main Stage');
    expect(deriveShort('Beer Garden & Merch Tent', 16)).toBe('Beer Garden');
    for (const label of ['Main Stage, North Side Tent', 'Ground Control Dispatch Team', 'The very long post name here']) {
      const out = deriveShort(label, 16);
      expect(out).not.toMatch(/[.,;:–—\-/(…]$/);
      expect(out).not.toContain('…');
      expect(out.length).toBeLessThanOrEqual(16);
    }
  });

  it('cuts a 60-character label with no spaces hard at the limit', () => {
    const label = 'A'.repeat(60);
    expect(deriveShort(label, 16)).toBe('A'.repeat(16));
    expect(deriveShort(label, 24)).toBe('A'.repeat(24));
  });

  it('keeps emoji whole', () => {
    expect(deriveShort('🍺 Beer Garden', 16)).toBe('🍺 Beer Garden');
    expect(deriveShort('🍺 Beer Garden North Tent', 16)).toBe('🍺 Beer Garden');
    // Each 👩🏽‍⚕️ is 7 UTF-16 units: two fit in 16, never half of one.
    const out = deriveShort('👩🏽‍⚕️👩🏽‍⚕️👩🏽‍⚕️👩🏽‍⚕️', 16);
    expect(out).toBe('👩🏽‍⚕️👩🏽‍⚕️');
    expect(out.length).toBeLessThanOrEqual(16);
  });

  it('a label of separators only still gives a non-empty short within the limit', () => {
    const label = '– – – – – – – – – – – –';
    const out = deriveShort(label, 16);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(16);
    expect(deriveShort(' – / : ', 16)).toBe('– / :');
  });

  it('ignores leading and trailing spaces, and collapses inner runs', () => {
    expect(deriveShort('   Gate A   ', 16)).toBe('Gate A');
    expect(deriveShort('  FA 1 – Main Stage  ', 16)).toBe('FA 1');
    expect(deriveShort('Ground   Control   Dispatch   Team', 24)).toBe('Ground Control Dispatch');
    expect(deriveShort('   ', 16)).toBe('');
  });
});

describe('effectiveShort', () => {
  it('a typed Short wins; a blank one is derived', () => {
    expect(effectiveShort('FA 1 – Main Stage', 'Main', 16)).toBe('Main');
    expect(effectiveShort('FA 1 – Main Stage', '  ', 16)).toBe('FA 1');
    expect(effectiveShort('FA 1 – Main Stage', undefined, 16)).toBe('FA 1');
  });
});
