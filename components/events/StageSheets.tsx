'use client';
// (Events, lead screens) The confirmation sheets of the stage actions: Go live (design/screens/events-v2-h), End event
// (events-v1-e) and Reopen. Each shows the event, the stage it moves from and to, the numbers it acts on, and one
// line of fact: these actions delete, lock out or clear, so here a full sentence is right.
import { Button, VisuallyHidden } from '@radix-ui/themes';
import { Archive, ArrowRight, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type { EventAdmin, EventStage } from '@/lib/api-types';
import { Sheet, SheetDescription, SheetTitle } from '@/components/ui/Sheet';
import { EventLogo, FieldError, STAGE_LABEL, StageChip } from './parts';
import { canGoLive, lpNumber } from './setup-model';
import s from './events.module.css';

export type StageAction = 'goLive' | 'end' | 'reopen';

const TITLE: Readonly<Record<StageAction, string>> = { goLive: 'Go live', end: 'End event', reopen: 'Reopen' };
const TO: Readonly<Record<StageAction, EventStage>> = { goLive: 'live', end: 'archived', reopen: 'live' };

export const FACT: Readonly<Record<StageAction, string>> = {
  goLive: 'Practice requests are deleted and numbering restarts at LP-0001.',
  end: 'Staff are signed out. Nothing is deleted; open requests are frozen as they are.',
  reopen: 'The staff password and join link are cleared and must be set again.',
};

interface StageSheetProps {
  action: StageAction;
  event: EventAdmin;
  /** Request counts from the Events list (null while they load). */
  counts: { requests: number; open: number } | null;
  onClose: () => void;
  /** Runs the action; resolves with an error message, or null when done (the sheet then closes). */
  onConfirm: () => Promise<string | null>;
}

export function StageSheet({ action, event, counts, onClose, onConfirm }: StageSheetProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = action === 'goLive' && !canGoLive(event);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    const problem = await onConfirm();
    setBusy(false);
    if (problem) setError(problem);
  };
  const n = (v: number | undefined) => (counts && v !== undefined ? String(v) : '—');
  return (
    <Sheet open onOpenChange={(open) => (open || busy ? undefined : onClose())} titleInContent dismissOnOutside={!busy}>
      <div className={s.sheetHead}>
        <EventLogo name={event.name} logoUrl={event.logoUrl} size={44} />
        <div style={{ minWidth: 0 }}>
          <SheetTitle className={s.sheetTitle}>{TITLE[action]}</SheetTitle>
          <p className={s.sheetSub}>{event.name}</p>
        </div>
      </div>
      <div className={s.transition}>
        <StageChip stage={event.stage} />
        <ArrowRight size={16} aria-hidden />
        <StageChip stage={TO[action]} />
        <VisuallyHidden>
          From {STAGE_LABEL[event.stage]} to {STAGE_LABEL[TO[action]]}.
        </VisuallyHidden>
      </div>
      <div className={s.tiles}>
        {action === 'goLive' ? (
          <>
            <div>
              <div className={s.tileK}>Practice requests</div>
              <div className={s.tileV} data-testid="sheet-practice-count">
                {n(counts?.requests)}
              </div>
            </div>
            <div>
              <div className={s.tileK}>Starts at</div>
              <div className={s.tileV}>{lpNumber(1)}</div>
            </div>
          </>
        ) : (
          <>
            <div>
              <div className={s.tileK}>Open</div>
              <div className={s.tileV}>{n(counts?.open)}</div>
            </div>
            <div>
              <div className={s.tileK}>Logged</div>
              <div className={s.tileV}>{n(counts?.requests)}</div>
            </div>
          </>
        )}
      </div>
      <SheetDescription className={s.fact}>{blocked ? 'Add at least one post and one team first.' : FACT[action]}</SheetDescription>
      {error ? <FieldError id="stage-error">{error}</FieldError> : null}
      <div className={s.sheetActs} style={{ marginTop: error ? 12 : 0 }}>
        <Button size="4" variant="soft" color="gray" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {action === 'end' ? (
          <Button size="4" variant="soft" className={s.endBtn} onClick={confirm} loading={busy} data-testid="stage-confirm">
            <Archive size={18} aria-hidden />
            End event
          </Button>
        ) : (
          <Button size="4" highContrast onClick={confirm} loading={busy} disabled={blocked} data-testid="stage-confirm">
            {action === 'goLive' ? <span className={s.dot} aria-hidden /> : <RotateCcw size={18} aria-hidden />}
            {TITLE[action]}
          </Button>
        )}
      </div>
    </Sheet>
  );
}
