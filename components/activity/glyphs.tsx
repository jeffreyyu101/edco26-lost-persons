'use client';
// The Activity row's bare outline glyph (no container), one per kind (lib/activity.ts ACTIVITY_GLYPH). The
// walking figure is not in lucide: it is the design's own path (design/screens/f34-states.html P.walk).
import { ArrowLeftRight, Cross, Hourglass, MapPin, MessageSquare, Pencil, Plus, TimerOff, Undo2, Users } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import type { ActivityIcon, ActivityTone } from '@/lib/activity';
import { CheckIcon, XIcon, type IconProps } from './icons';

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

const LUCIDE: Readonly<Record<Exclude<ActivityIcon, 'walk'>, ComponentType<IconProps>>> = {
  'message-square': MessageSquare,
  cross: Cross,
  check: CheckIcon,
  'map-pin': MapPin,
  hourglass: Hourglass,
  x: XIcon,
  'undo-2': Undo2,
  plus: Plus,
  pencil: Pencil,
  'timer-off': TimerOff,
};

/**
 * (Companion) The new kinds' glyphs: amber users (accompanied), blue swap (swap requested), green swap (approved),
 * grey swap-x (declined), grey users (friend informed). Read by kind first, so the rows draw them whatever icon names
 * lib/activity's ACTIVITY_GLYPH gives them.
 */
export type CompanionIcon = 'users' | 'arrow-left-right' | 'swap-x';
export type GlyphTone = ActivityTone | 'amber';
export const COMPANION_ACTIVITY_GLYPH: Readonly<Record<string, { icon: CompanionIcon; tone: GlyphTone }>> = {
  accompanied: { icon: 'users', tone: 'amber' },
  swap_requested: { icon: 'arrow-left-right', tone: 'blue' },
  swap_approved: { icon: 'arrow-left-right', tone: 'green' },
  swap_declined: { icon: 'swap-x', tone: 'gray' },
  friend_informed: { icon: 'users', tone: 'gray' },
};

/** lucide arrow-left-right struck through: a declined swap. */
function SwapXIcon({ size = 18, strokeWidth = 1.9, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" {...rest}>
      <path d="M8 3 4 7l4 4" />
      <path d="M4 7h16" />
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
      <path d="m3 3 18 18" />
    </svg>
  );
}

const EXTRA: Readonly<Record<CompanionIcon, ComponentType<IconProps>>> = {
  users: Users,
  'arrow-left-right': ArrowLeftRight,
  'swap-x': SwapXIcon,
};

/** step 11 of the tone's Radix scale (gray-11 for gray). */
export function toneVar(tone: GlyphTone): string {
  return `var(--${tone}-11)`;
}

export function ActivityGlyphIcon({ icon, tone, size = 18, kind }: { icon: ActivityIcon | CompanionIcon; tone: GlyphTone; size?: number; kind?: string }) {
  const companion = kind ? COMPANION_ACTIVITY_GLYPH[kind] : undefined;
  if (companion) {
    icon = companion.icon;
    tone = companion.tone;
  }
  const style = { color: toneVar(tone) };
  if (icon === 'walk') return <WalkIcon size={size} style={style} data-icon={icon} data-tone={tone} />;
  const Icon = (LUCIDE as Readonly<Record<string, ComponentType<IconProps>>>)[icon] ?? EXTRA[icon as CompanionIcon] ?? MessageSquare;
  return <Icon size={size} strokeWidth={1.9} aria-hidden style={style} data-icon={icon} data-tone={tone} />;
}
