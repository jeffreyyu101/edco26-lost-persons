// The walking person of the en route row, button and pill, ported exactly from design/screens/updates.html
// (P.walk). lucide has no walking figure; this is a bare outline glyph like the lucide icons around it.
import type { CSSProperties } from 'react';

export function WalkIcon({ size = 16, strokeWidth = 2, className, style }: { size?: number; strokeWidth?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
      style={{ flex: 'none', ...style }}
    >
      <circle cx="13" cy="4" r="2" />
      <path d="m7 21 2-6 3 3v3" />
      <path d="m9 12 2-4 3 2 3 1" />
      <path d="M11 8 8 9 6 12" />
    </svg>
  );
}
