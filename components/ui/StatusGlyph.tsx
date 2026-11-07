// The status glyph, ported exactly from the mockups (design/screens/*.html `glyph()`): a 14×14 viewBox.
//   waiting       empty ring, blue        notInMedical  filled circle with ×, grey (closed, v2.2)
//   inMedical     ring with a ¾ pie, green closed      filled check, grey
//   queued        dashed ring, grey        logged       empty ring, gray-10
//   inactive      (F6) lucide timer-off, a bare outline (no circle), grey: Closed · inactive, unlike Reunited's ✓
// FINAL (Phase 1a): props are frozen; C may refine styling only.
import type { CSSProperties } from 'react';
import { statusMeta, type GlyphKind, type StatusValue } from '@/lib/domain';

const COLOR: Readonly<Record<GlyphKind, string>> = {
  waiting: 'var(--blue-9)',
  // v2.2 (Jeffrey, 2026-11-06): Not in medical is closed and greyed out like Reunited / Discharged / Cancelled.
  notInMedical: 'var(--gray-9)',
  inMedical: 'var(--green-9)',
  closed: 'var(--gray-9)',
  queued: 'var(--gray-9)',
  logged: 'var(--gray-10)',
  // (F6) gray-9, as the other closed glyphs (3:1 on the panel in both themes).
  inactive: 'var(--gray-9)',
};

/** (F6) lucide timer-off (v1.70), on its 24 px grid: Closed · inactive. Drawn here so the first load needs no icon chunk. */
const TIMER_OFF = (
  <>
    <path d="M10 2h4" />
    <path d="M4.6 11a8 8 0 0 0 1.7 8.7 8 8 0 0 0 8.7 1.7" />
    <path d="M7.4 7.4a8 8 0 0 1 10.3 1 8 8 0 0 1 .9 10.2" />
    <path d="m2 2 20 20" />
    <path d="M12 12v-2" />
  </>
);

/** The mockups' pie(f): a wedge from 12 o'clock, clockwise, radius 3.25 around (7, 7). */
export function piePath(fraction: number): string {
  const a = fraction * 2 * Math.PI;
  const x = 7 + 3.25 * Math.sin(a);
  const y = 7 - 3.25 * Math.cos(a);
  return `M7 7L7 3.75A3.25 3.25 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`;
}

const PIE_THREE_QUARTERS = piePath(0.75);

export type StatusGlyphProps = {
  /** Pixel size (mockups: 14 in lists, 12 in audit "from → to" and tiles, 15 in cards, 18 in the status block). */
  size?: number;
  /** When set, the glyph is announced (role="img"); otherwise it is decorative (aria-hidden). */
  label?: string;
  className?: string;
  style?: CSSProperties;
} & ({ status: StatusValue; kind?: never } | { kind: GlyphKind; status?: never });

export function StatusGlyph(props: StatusGlyphProps) {
  const kind: GlyphKind = props.kind ?? statusMeta(props.status ?? '').glyph;
  const size = props.size ?? 14;
  const c = COLOR[kind];
  const a11y = props.label ? { role: 'img' as const, 'aria-label': props.label } : { 'aria-hidden': true as const };
  if (kind === 'inactive') {
    // A line glyph draws one pixel larger than the rings, as the stage glyphs do (StageGlyph).
    return (
      <svg
        width={size + 1}
        height={size + 1}
        viewBox="0 0 24 24"
        fill="none"
        stroke={c}
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={props.className}
        style={{ flex: 'none', ...props.style }}
        data-glyph={kind}
        {...a11y}
      >
        {TIMER_OFF}
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      className={props.className}
      style={{ flex: 'none', ...props.style }}
      data-glyph={kind}
      {...a11y}
    >
      {kind === 'closed' ? (
        <>
          <circle cx="7" cy="7" r="6.25" fill={c} />
          <path
            d="M4.4 7.2l1.8 1.8 3.5-3.6"
            fill="none"
            stroke="var(--color-panel-solid)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : kind === 'notInMedical' ? (
        <>
          <circle cx="7" cy="7" r="6.25" fill={c} />
          <path d="M5 5l4 4M9 5l-4 4" stroke="var(--color-panel-solid)" strokeWidth="1.6" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle
            cx="7"
            cy="7"
            r="5.75"
            fill="none"
            stroke={c}
            strokeWidth="1.5"
            strokeDasharray={kind === 'queued' ? '2.2 2' : undefined}
          />
          {kind === 'inMedical' ? <path d={PIE_THREE_QUARTERS} fill={c} /> : null}
        </>
      )}
    </svg>
  );
}
