// The brand row over All requests (design/screens/brand-compact.html option A + brand-compact-1.png, approved
// by Brian 2026-11-06 ~14:30). It replaces the tall brand card of the morning release in one row: Jeffrey's
// gradient (his original header, git show 1f4580b:app/ui.tsx .topbar), (events) the event's logo (white when it is a
// single-colour transparent logo) and the permanent Ground Control logo with a thin divider, "Is my friend in
// medical?" with the event's dates under it ("Nov 14–15"; on a wide screen "November 14–15, 2026" beside the title;
// BrandEvent.tsx reads both from the event config on the client), and an X that hides it on this device
// (prefs.brandHidden). The avatar menu's "Show header" brings it back. Always dark, in both themes.
//
// All requests only: Pending and My requests start at their title. It scrolls away with the page; the sticky
// bar under it stays. It has a fixed height and the logos carry their size, so it never moves what is below
// it while they load, and a hidden row is never drawn at all (the list views render only in the browser,
// where the pref is known from the first frame).
//
// From 768 px the desk shell draws the same row above its top bar on All requests (app/app-shell.tsx,
// components/desk/DeskFrame.tsx; design/screens/live-indicator.html, the Desktop frame). No 'use client': it
// has no state, so the page (a server component) renders the desk's copy with no JavaScript of its own on the
// first load, while the phone's list (a client chunk) imports it as client code. The desk's X has no handler
// here: the frame's brand slot catches its click ([data-brand-hide]), and the pre-paint script keeps a hidden
// row from showing before hydration (lib/brand-pref.ts).
import { X } from 'lucide-react';
import { memo } from 'react';
import { BrandEventDates, BrandEventLogo } from './BrandEvent';
import b from './brand.module.css';

/** The X's accessible name; the avatar menu item that undoes it is "Show header". */
export const HIDE_HEADER_LABEL = 'Hide header';

export interface BrandCardProps {
  /** The X: hide the row on this device. Left out on the desk's server-drawn copy (its slot handles the click). */
  onHide?: () => void;
  /**
   * 'lazy' for the desk's copy, which the server draws at every width and a phone keeps display: none until
   * it is hydrated: a hidden lazy image is never fetched, so the phone loads the logos exactly as before
   * (for its own row). Left out, the images load as usual.
   */
  logoLoading?: 'lazy';
}

export const BrandCard = memo(function BrandCard({ onHide, logoLoading }: BrandCardProps) {
  return (
    <div className={b.brand} data-testid="brand-card">
      <div className={b.logos}>
        <BrandEventLogo loading={logoLoading} />
        <img className={b.gc} src="/logos/ground-control.png" alt="Ground Control" width={313} height={120} decoding="async" loading={logoLoading} />
      </div>
      <span className={`${b.div} ${b.wideOnly}`} aria-hidden="true" />
      <div className={b.words}>
        <p className={b.title}>
          Is my friend <span className={b.accent}>in medical?</span>
        </p>
        <BrandEventDates />
      </div>
      <button
        type="button"
        className={b.hide}
        aria-label={HIDE_HEADER_LABEL}
        onClick={onHide}
        data-brand-hide=""
        data-testid="brand-hide"
      >
        <X size={15} strokeWidth={2.25} aria-hidden />
      </button>
    </div>
  );
});
