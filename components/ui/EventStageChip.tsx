'use client';
// (Events) The signed-in event's stage chip for a header (StageChip: Practice amber half ring, Live green dot,
// Archived grey box). `practiceOnly`: a screen whose header shows the chip only in practice (the request, the form, the
// dashboard), so nobody takes practice for live on any screen; the lists and the desk's top bar show every stage.
import { useEventConfig } from '@/lib/client/event-config';
import { StageChip } from './StageChip';

export function EventStageChip({ practiceOnly = false, size = 'sm', className }: { practiceOnly?: boolean; size?: 'sm' | 'md'; className?: string }) {
  const stage = useEventConfig()?.stage;
  if (!stage || (practiceOnly && stage !== 'practice')) return null;
  return <StageChip stage={stage} size={size} className={className} />;
}
