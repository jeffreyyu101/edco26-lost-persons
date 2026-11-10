'use client';
// (Events, lead screens) The confirmation sheets of the stage actions: Go live (design/screens/events-v2-h), End event
// (events-v1-e) and Reopen. Each shows the event, the stage it moves from and to, the numbers it acts on, and one
// line of fact: these actions delete, lock out or clear, so here a full sentence is right.
// (Grace period) Reopen also shows what it keeps: Password and Join link, each Kept or New one needed, and the time
// left while inside the 24 h after End.
import { Button, VisuallyHidden } from '@radix-ui/themes';
import { Archive, ArrowRight, Check, RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EventAdmin, EventStage } from '@/lib/api-types';
import { Sheet, SheetDescription, SheetTitle } from '@/components/ui/Sheet';
import { formatLeft, reopenKeeps, spokenLeft } from './format';
import { EventLogo, FieldError, STAGE_LABEL, StageChip } from './parts';
import { canGoLive, lpNumber } from './setup-model';
import s from './events.module.css';

export type StageAction = 'goLive' | 'end' | 'reopen';

const TITLE: Readonly<Record<StageAction, string>> = { goLive: 'Go live', end: 'End event', reopen: 'Reopen' };
const TO: Readonly<Record<StageAction, EventStage>> = { goLive: 'live', end: 'archived', reopen: 'live' };

export const FACT: Readonly<Record<StageAction, string>> = {
  goLive: 'Practice requests are deleted and numbering restarts at LP-0001.',
  end: 'Staff are signed out and nothing is deleted; within 24 hours it can be reopened with the same password and join link.',
  reopen: 'Open requests resume as they were; staff sign in again.',
};

/** One row of what a Reopen keeps: the label, then a chip (✓ Kept / ↻ New one needed). */
function KeepRow({ label, kept, testId, spoken }: { label: string; kept: boolean; testId: string; spoken: string }) {
  return (
    <div className={s.r}>
      <span className={s.k}>{label}</span>
      <span className={s.keep} data-kept={kept} data-testid={testId}>
        {kept ? <Check size={13} strokeWidth={2.25} aria-hidden /> : <RefreshCw size={12} strokeWidth={2.25} aria-hidden />}
        <span aria-hidden>{kept ? 'Kept' : 'New one needed'}</span>
        <VisuallyHidden>{spoken}</VisuallyHidden>
      </span>
    </div>
  );
}

/** Reopen: what it keeps, judged by the clock while the sheet is open (the server decides again at Reopen). */
function ReopenKeeps({ event }: { event: EventAdmin }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  const k = reopenKeeps(event, now);
  return (
    <div className={`${s.grp} ${s.keeps}`} data-testid="reopen-keeps" data-held={k.held}>
      <KeepRow
        label="Password"
        kept={k.password}
        testId="reopen-password"
        spoken={k.password ? 'The staff password is kept.' : 'A new staff password is needed after reopening.'}
      />
      <KeepRow
        label="Join link"
        kept={k.joinLink}
        testId="reopen-join-link"
        spoken={k.joinLink ? 'The join link is kept.' : 'A new join link is needed after reopening.'}
      />
      {k.held ? (
        <div className={s.r}>
          <span className={s.k}>Time left</span>
          <span className={`${s.v} ${s.left}`} data-testid="reopen-left">
            <span aria-hidden>{formatLeft(k.leftMs)}</span>
            <VisuallyHidden>Reopen within {spokenLeft(k.leftMs)} to keep them.</VisuallyHidden>
          </span>
        </div>
      ) : null}
    </div>
  );
}

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
      {action === 'reopen' ? <ReopenKeeps event={event} /> : null}
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
