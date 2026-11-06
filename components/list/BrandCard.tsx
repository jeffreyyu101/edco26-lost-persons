'use client';
// The brand card at the top of All requests, Pending and My requests (Jeffrey, 2026-11-06 10:31: "add logo,
// event details, the 'is my friend in medical' bigger and similar design to the previous version"). It is
// his original header (git show 1f4580b:app/ui.tsx .topbar): the dark gradient banner with faint orbit
// rings top-right, the EDC Orlando (white) and Ground Control logos with a thin divider, the event kicker,
// the big title with "in medical?" in cyan, and the credit line. Always dark, in both themes.
//
// It scrolls away with the page; the sticky bar under it (the view menu title, search, the avatar) stays.
// Nothing in it waits for data, and the logos carry their size, so it never moves what is below it.
import { memo } from 'react';
import b from './brand.module.css';

/** The kicker, written in sentence case (CSS sets the capitals, so screen readers read words, not letters). */
export const BRAND_KICKER = 'Event operations · November 6–8, 2026';
export const BRAND_CREDIT_NAMES = 'Jeffrey & Brian';
export const BRAND_CREDIT_FOR = 'Ground Control / Headliner Experience';

export const BrandCard = memo(function BrandCard() {
  return (
    <div className={b.brand} data-testid="brand-card">
      <div className={b.orbit} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className={b.logos}>
        <img className={b.edc} src="/logos/edc-orlando.png" alt="EDC Orlando" width={194} height={132} decoding="async" />
        <span className={b.div} aria-hidden="true" />
        <img className={b.gc} src="/logos/ground-control.png" alt="Ground Control" width={313} height={120} decoding="async" />
      </div>
      <p className={b.kicker}>{BRAND_KICKER}</p>
      <p className={b.title}>
        Is my friend <span className={b.accent}>in medical?</span>
      </p>
      <p className={b.credit}>
        Built by <b>{BRAND_CREDIT_NAMES}</b> <span className={b.creditFor}>for {BRAND_CREDIT_FOR}</span>
      </p>
    </div>
  );
});
