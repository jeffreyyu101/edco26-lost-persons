'use client';
// (Phase 3) The alerts reminder's place at first paint. The banner (AlertsBanner, a lazy chunk) can only draw once
// /api/push/prefs has answered, often after the list's first paint, and it pushed the list down 128 px on a phone and
// 90 px on the desk on every cold load. This device remembers the banner it showed last (localStorage
// `lp-alerts-banner`: its state and, per place, its height and margins; device-wide, not per event), and the slot
// draws that box, in the banner's own tint, from the first paint until the banner itself (or the answer that it is
// gone) arrives. A first-ever visit still shifts once. Small on purpose: it is in the views' chunks, not F4's.
import type { CSSProperties } from 'react';

export type BannerPlaceName = 'list' | 'desk-main' | 'desk-table';
type BannerState = 'off' | 'install' | 'blocked';
interface Box {
  h: number;
  m: string;
}
interface Memory {
  s: BannerState;
  at: Partial<Record<BannerPlaceName, Box>>;
}

export const BANNER_MEMORY_KEY = 'lp-alerts-banner';

function read(): Memory | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(BANNER_MEMORY_KEY) ?? 'null') as Memory | null;
    return v && (v.s === 'off' || v.s === 'install' || v.s === 'blocked') && v.at && typeof v.at === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** The banner was drawn in `place` with this state and box. */
export function rememberBanner(state: BannerState, place: BannerPlaceName, el: HTMLElement): void {
  try {
    const css = window.getComputedStyle(el);
    const box: Box = { h: el.offsetHeight, m: css.margin };
    if (!(box.h > 0)) return;
    const old = read();
    const next: Memory = { s: state, at: { ...(old?.s === state ? old.at : {}), [place]: box } };
    window.localStorage.setItem(BANNER_MEMORY_KEY, JSON.stringify(next));
  } catch {
    // No storage: the next cold load shifts as before.
  }
}

/** The answer came: no banner on this device. */
export function forgetBanner(): void {
  try {
    window.localStorage.removeItem(BANNER_MEMORY_KEY);
  } catch {
    // Nothing to forget.
  }
}

const TINT: Record<BannerState, [string, string]> = {
  off: ['var(--blue-a3)', 'var(--blue-a5)'],
  install: ['var(--blue-a3)', 'var(--blue-a5)'],
  blocked: ['var(--amber-a3)', 'var(--amber-a5)'],
};

/** The remembered banner's box in `place`, or nothing (no banner last time, or never drawn here). */
export function BannerPlace({ place }: { place: BannerPlaceName }) {
  if (typeof window === 'undefined') return null;
  const memory = read();
  const box = memory?.at[place];
  if (!memory || !box) return null;
  const [bg, edge] = TINT[memory.s];
  const style: CSSProperties = { height: box.h, margin: box.m, borderRadius: 12, background: bg, boxShadow: `inset 0 0 0 1px ${edge}`, boxSizing: 'border-box' };
  return <div style={style} aria-hidden data-testid="alerts-banner-place" data-state={memory.s} />;
}
