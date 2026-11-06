'use client';
// The brand row over All requests (design/screens/brand-compact.html option A + brand-compact-1.png, approved
// by Brian 2026-11-06 ~14:30). It replaces the tall brand card of the morning release in one row: Jeffrey's
// gradient (his original header, git show 1f4580b:app/ui.tsx .topbar), the EDC Orlando (white) and Ground
// Control logos with a thin divider, "Is my friend in medical?" with the event dates under it ("Nov 6–8"; on
// a wide screen "November 6–8, 2026" beside the title), and an X that hides it on this device
// (prefs.brandHidden). The avatar menu's "Show header" brings it back. Always dark, in both themes.
//
// All requests only: Pending and My requests start at their title. It scrolls away with the page; the sticky
// bar under it stays. It has a fixed height and the logos carry their size, so it never moves what is below
// it while they load, and a hidden row is never drawn at all (the list views render only in the browser,
// where the pref is known from the first frame).
import { X } from 'lucide-react';
import { memo } from 'react';
import b from './brand.module.css';

/** The dates, written in sentence case (CSS sets the capitals, so screen readers read words, not letters). */
export const BRAND_DATES_SHORT = 'Nov 6–8';
export const BRAND_DATES_LONG = 'November 6–8, 2026';
/** The X's accessible name; the avatar menu item that undoes it is "Show header". */
export const HIDE_HEADER_LABEL = 'Hide header';

export interface BrandCardProps {
  /** The X: hide the row on this device. */
  onHide: () => void;
}

export const BrandCard = memo(function BrandCard({ onHide }: BrandCardProps) {
  return (
    <div className={b.brand} data-testid="brand-card">
      <div className={b.logos}>
        <img className={b.edc} src="/logos/edc-orlando.png" alt="EDC Orlando" width={194} height={132} decoding="async" />
        <span className={b.div} aria-hidden="true" />
        <img className={b.gc} src="/logos/ground-control.png" alt="Ground Control" width={313} height={120} decoding="async" />
      </div>
      <span className={`${b.div} ${b.wideOnly}`} aria-hidden="true" />
      <div className={b.words}>
        <p className={b.title}>
          Is my friend <span className={b.accent}>in medical?</span>
        </p>
        <p className={`${b.dates} ${b.datesShort}`}>{BRAND_DATES_SHORT}</p>
        <p className={`${b.dates} ${b.datesLong}`}>{BRAND_DATES_LONG}</p>
      </div>
      <button type="button" className={b.hide} aria-label={HIDE_HEADER_LABEL} onClick={onHide} data-testid="brand-hide">
        <X size={15} strokeWidth={2.25} aria-hidden />
      </button>
    </div>
  );
});
