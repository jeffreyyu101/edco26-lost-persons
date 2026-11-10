'use client';
// (Events, lead screens) Small pieces: the stage chip (Practice amber half-ring, Live green dot, Archived grey box;
// spec "Client"), the logo tile (the uploaded logo, or the name's initials) and an inline field error.
import { Archive, CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { EventStage } from '@/lib/api-types';
import { EventLogo as ThemedLogo } from '@/components/ui/EventLogo';
import { initials } from './format';
import s from './events.module.css';

export const STAGE_LABEL: Readonly<Record<EventStage, string>> = { practice: 'Practice', live: 'Live', archived: 'Archived' };

/** The half-filled ring of Practice (amber), on the 14 px grid. */
function HalfRing() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="7" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
    </svg>
  );
}

export function StageGlyph({ stage }: { stage: EventStage }) {
  if (stage === 'practice') return <HalfRing />;
  if (stage === 'live') return <span className={s.stageDot} aria-hidden />;
  return <Archive size={13} strokeWidth={2} aria-hidden />;
}

export function StageChip({ stage }: { stage: EventStage }) {
  return (
    <span className={s.stage} data-stage={stage} data-testid="event-stage">
      <StageGlyph stage={stage} />
      {STAGE_LABEL[stage]}
    </span>
  );
}

/**
 * The event's logo on a tile, or its initials. Decoration: the name is always next to it. A single-colour transparent
 * logo is drawn in the theme's ink (dark on light, white on dark), as on sign-in (components/ui/EventLogo.tsx); any
 * other logo as uploaded.
 */
export function EventLogo({ name, logoUrl, size = 44 }: { name: string; logoUrl: string | null; size?: number }) {
  return (
    <span className={s.tile} style={{ width: size, height: size, borderRadius: Math.round(size * 0.23), fontSize: Math.round(size * 0.38) }} aria-hidden>
      {logoUrl ? <ThemedLogo src={logoUrl} surface="theme" height={size} /> : initials(name)}
    </span>
  );
}

export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p className={s.err} id={id} role="alert">
      <CircleAlert size={14} strokeWidth={1.75} aria-hidden />
      {children}
    </p>
  );
}
