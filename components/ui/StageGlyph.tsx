// (F5) A stage's glyph (lib/domain STAGE_META; design/screens/colors-1.png). Bare outline glyphs, never on a
// circle background: the status rings are StatusGlyph's (ring, ring with a ¾ pie, filled ×, filled ✓), and the
// new stages add a ring with "?" (Needs info, amber), an hourglass (Not found yet, violet), a walking figure
// (Friend en route, teal) and a plain check (Friend arrived, green). The rings use step 9 of their colour, the
// line glyphs and the "?" ring step 11 (amber 9 is under 3:1 on white). Decorative unless `label` is set.
import type { CSSProperties } from 'react';
import { Check, Hourglass } from 'lucide-react';
import type { GlyphKind, StageGlyphKind } from '@/lib/domain';
import { StatusGlyph } from './StatusGlyph';

export interface StageGlyphProps {
  glyph: StageGlyphKind;
  /** The ring's pixel size (line glyphs draw one pixel larger, as in the mockups). */
  size?: number;
  label?: string;
  className?: string;
  style?: CSSProperties;
}

/** The walking figure (design/screens/updates.html P.walk), on the 24 px grid. */
const WALK = (
  <>
    <circle cx="13" cy="4" r="2" />
    <path d="m7 21 2-6 3 3v3" />
    <path d="m9 12 2-4 3 2 3 1" />
    <path d="M11 8 8 9 6 12" />
  </>
);

export function StageGlyph({ glyph, size = 14, label, className, style }: StageGlyphProps) {
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  const common = { className, style: { flex: 'none' as const, ...style }, 'data-glyph': glyph, ...a11y };
  switch (glyph) {
    case 'needsInfo':
      // The ring with a "?" (updates.html gQ), drawn as paths so it never depends on a font.
      return (
        <svg width={size} height={size} viewBox="0 0 14 14" {...common}>
          <circle cx="7" cy="7" r="5.75" fill="none" stroke="var(--amber-11)" strokeWidth="1.5" />
          <path
            d="M5.6 5.6a1.45 1.45 0 0 1 2.82.47c0 .97-1.42 1.3-1.42 1.3"
            fill="none"
            stroke="var(--amber-11)"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="7" cy="9.55" r="0.75" fill="var(--amber-11)" />
        </svg>
      );
    case 'hourglass':
      return <Hourglass size={size + 1} strokeWidth={2} color="var(--violet-11)" {...common} />;
    case 'walk':
      return (
        <svg
          width={size + 1}
          height={size + 1}
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--teal-11)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          {...common}
        >
          {WALK}
        </svg>
      );
    case 'arrived':
      return <Check size={size + 1} strokeWidth={2.4} color="var(--green-11)" {...common} />;
    default:
      return <StatusGlyph kind={glyph as GlyphKind} size={size} className={className} style={style} {...(label ? { label } : {})} />;
  }
}
