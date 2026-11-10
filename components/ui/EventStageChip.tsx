'use client';
// (Events) The signed-in event's stage chip for a header (StageChip: Practice amber half ring, Live green dot,
// Archived grey box). Practice shows on every screen, so nobody takes practice for live: `only` lists the stages a
// header shows (the request, the form and the dashboard: practice; the desk's top bar: practice and archived, since its
// live line already says live; the phone lists: every stage).
import type { EventStage } from '@/lib/api-types';
import { useEventConfig } from '@/lib/client/event-config';
import { StageChip } from './StageChip';

const EVERY: readonly EventStage[] = ['practice', 'live', 'archived'];
/** The screens whose header shows the chip in practice only. */
export const PRACTICE: readonly EventStage[] = ['practice'];
const DESK: readonly EventStage[] = ['practice', 'archived'];
/** The desk's top bar: practice and archived (its live line already says live). */
export const DESK_STAGES = DESK;

export function EventStageChip({ only = EVERY, size = 'sm', className }: { only?: readonly EventStage[]; size?: 'sm' | 'md'; className?: string }) {
  const stage = useEventConfig()?.stage;
  if (!stage || !only.includes(stage)) return null;
  return <StageChip stage={stage} size={size} className={className} />;
}
