'use client';
// Stage chips on cards. (F5) A My requests card's corner carries a solid chip for Needs info (amber), the stage
// front of house has to answer (design/screens/colors-3.png). (Pending v9.1, Brian 2026-11-06,
// design/screens/pending-v9.html) A "Not found yet" hold is an indicator in its own chip row under the card's
// text, never a time: an outlined violet "⧗ Not found yet" while held, a filled violet "↺ Recheck due" (lucide
// history) once RECHECK_MINUTES have passed. One line each, never wrapped.
import { History, Hourglass } from 'lucide-react';
import { StageGlyph } from '@/components/ui/StageGlyph';
import { NOT_FOUND_YET_LABEL } from '@/lib/domain';
import { RECHECK_DUE_LABEL, type DisplayStage } from '@/lib/stages';
import s from './list.module.css';

/** The stages that get a chip in a My requests card's corner (a hold is a chip row of its own). */
export function hasStageChip(stage: Pick<DisplayStage, 'key'>): boolean {
  return stage.key === 'needsInfo';
}

export function StageChip({ stage }: { stage: DisplayStage }) {
  return (
    <span className={s.stageChip} data-tone={stage.tone} data-testid="stage-chip">
      <StageGlyph glyph={stage.glyph} size={12} />
      {stage.label}
    </span>
  );
}

/** "⧗ Not found yet" (outlined) or, once due, "↺ Recheck due" (filled), violet. Hidden from screen readers: the
 * card's sentence says it. */
export function HoldChip({ due }: { due: boolean }) {
  return (
    <span className={s.holdChip} data-due={due ? '' : undefined} data-testid="hold-chip" aria-hidden>
      {due ? <History size={13} strokeWidth={2.25} aria-hidden /> : <Hourglass size={13} strokeWidth={2} aria-hidden />}
      {due ? RECHECK_DUE_LABEL : NOT_FOUND_YET_LABEL}
    </span>
  );
}
