'use client';
// The Activity row's bare outline glyph (no container), one per kind (lib/activity.ts ACTIVITY_GLYPH). The
// walking figure is not in lucide: it is the design's own path (design/screens/f34-states.html P.walk).
import { Check, Cross, Hourglass, MapPin, MessageSquare, Pencil, Plus, Undo2, X, type LucideProps } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import type { ActivityIcon, ActivityTone } from '@/lib/activity';

export function WalkIcon({ size = 17, strokeWidth = 1.9, ...rest }: { size?: number; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, 'ref'>) {
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
      focusable="false"
      {...rest}
    >
      <circle cx="13" cy="4" r="2" />
      <path d="m7 21 2-6 3 3v3" />
      <path d="m9 12 2-4 3 2 3 1" />
      <path d="M11 8 8 9 6 12" />
    </svg>
  );
}

const LUCIDE: Readonly<Record<Exclude<ActivityIcon, 'walk'>, ComponentType<LucideProps>>> = {
  'message-square': MessageSquare,
  cross: Cross,
  check: Check,
  'map-pin': MapPin,
  hourglass: Hourglass,
  x: X,
  'undo-2': Undo2,
  plus: Plus,
  pencil: Pencil,
};

/** step 11 of the tone's Radix scale (gray-11 for gray). */
export function toneVar(tone: ActivityTone): string {
  return `var(--${tone}-11)`;
}

export function ActivityGlyphIcon({ icon, tone, size = 18 }: { icon: ActivityIcon; tone: ActivityTone; size?: number }) {
  const style = { color: toneVar(tone) };
  if (icon === 'walk') return <WalkIcon size={size} style={style} data-icon={icon} data-tone={tone} />;
  const Icon = LUCIDE[icon];
  return <Icon size={size} strokeWidth={1.9} aria-hidden style={style} data-icon={icon} data-tone={tone} />;
}
