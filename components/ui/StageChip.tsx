// (Events) The event's stage as a chip (design/screens/events-v2: StatusGlyph family, 14 grid): Practice (amber, half
// ring), Live (green, dot), Archived (grey, archive box). Server-safe (no hooks): the header, the Ended screen and the
// lead screens draw the same one. The screen reader hears the stage as words ("Practice event").
import type { EventStage } from '@/lib/api-types';
import styles from './stage-chip.module.css';

const LABEL: Record<EventStage, string> = { practice: 'Practice', live: 'Live', archived: 'Archived' };
const SAID: Record<EventStage, string> = { practice: 'Practice event', live: 'Live event', archived: 'Archived event' };

function Glyph({ stage }: { stage: EventStage }) {
  if (stage === 'practice') {
    return (
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7 3.75A3.25 3.25 0 0 1 7 10.25Z" fill="currentColor" />
      </svg>
    );
  }
  if (stage === 'live') {
    return (
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="4" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

export interface StageChipProps {
  stage: EventStage;
  size?: 'sm' | 'md';
  className?: string;
}

export function StageChip({ stage, size = 'md', className }: StageChipProps) {
  return (
    <span
      className={[styles.chip, size === 'sm' ? styles.sm : '', className ?? ''].filter(Boolean).join(' ')}
      data-stage={stage}
      data-testid="stage-chip"
      role="img"
      aria-label={SAID[stage]}
    >
      <Glyph stage={stage} />
      <span aria-hidden="true">{LABEL[stage]}</span>
    </span>
  );
}
