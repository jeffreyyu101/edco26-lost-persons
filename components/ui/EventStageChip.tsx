'use client';
// (Events) The signed-in event's stage chip for a header (StageChip: Practice amber half ring, Live green dot,
// Archived grey box). Practice shows on every screen, so nobody takes practice for live: `only` lists the stages a
// header shows (the phone lists: every stage; the desk's top bar: practice and archived; the request, the form and the
// dashboard: practice).
import type { EventStage } from '@/lib/api-types';
import { useEventConfig } from '@/lib/client/event-config';
import { StageChip } from './StageChip';

const EVERY: readonly EventStage[] = ['practice', 'live', 'archived'];
/** The screens whose header shows the chip in practice only. */
export const PRACTICE: readonly EventStage[] = ['practice'];
/** The desk's top bar: practice and archived (its room goes to the title, count and line while live). */
export const NOT_LIVE: readonly EventStage[] = ['practice', 'archived'];

export function EventStageChip({ only = EVERY, size = 'sm', className }: { only?: readonly EventStage[]; size?: 'sm' | 'md'; className?: string }) {
  const stage = useEventConfig()?.stage;
  if (!stage || !only.includes(stage)) return null;
  return <StageChip stage={stage} size={size} className={className} />;
}
