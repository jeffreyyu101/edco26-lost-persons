'use client';
// (F5) The stage chips on a My requests card (design/screens/colors-3.png): top right, a solid chip for the two
// stages front of house has to notice, Needs info (amber) and Not found yet (violet); under the name, an outline
// violet "Recheck 4:40 PM" while held (also under a Needs info chip: the hold goes on while medical asks). Every
// other stage keeps the card's usual corner. One line, never wrapped.
import { RefreshCw } from 'lucide-react';
import { StageGlyph } from '@/components/ui/StageGlyph';
import type { DisplayStage } from '@/lib/stages';
import s from './list.module.css';

/** The stages that get a chip in the card's corner. */
export function hasStageChip(stage: Pick<DisplayStage, 'key'>): boolean {
  return stage.key === 'needsInfo' || stage.key === 'notFoundYet';
}

export function StageChip({ stage }: { stage: DisplayStage }) {
  return (
    <span className={s.stageChip} data-tone={stage.tone} data-testid="stage-chip">
      <StageGlyph glyph={stage.glyph} size={12} />
      {stage.label}
    </span>
  );
}

/** "⟳ Recheck 4:40 PM", outlined in violet, whenever the request is on hold (Needs info on hold included). */
export function RecheckChip({ stage }: { stage: DisplayStage }) {
  if (!stage.recheck) return null;
  return (
    <span className={s.recheckChip} data-due={stage.due ? '' : undefined} data-testid="recheck-time-chip">
      <RefreshCw size={13} strokeWidth={2} aria-hidden />
      {stage.recheck}
    </span>
  );
}
