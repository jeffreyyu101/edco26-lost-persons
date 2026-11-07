'use client';
// En route (F3; design/screens/updates.html "3 · En route", #edit, f34-states.html 5). One row says what is
// happening: teal "Friend en route" + "~4 min" (a minute countdown to the stored ETA; "now"; amber "late"),
// a small count when several staff are bringing the friend, green "Friend arrived". No names or teams.
// On a request I am en route on, the row is a button (chevron) that reopens the same sheet I started from,
// with my ETA selected, "Cancel en route" and "Update". For everyone else it is read-only (not a live region:
// its minute countdown must not be announced every minute).
// A tap of mine that was not delivered keeps what I asked for on screen with "Not delivered · Retry" and a
// Delete under it (EnrouteFailed), like a message bubble that was not delivered.
import { Button, IconButton, VisuallyHidden } from '@radix-ui/themes';
import { Check, ChevronRight, X } from 'lucide-react';
import { WalkIcon } from './WalkIcon';
import { useId, useState, type ReactNode } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import type { EnrouteSummary, RequestSummary } from '@/lib/api-types';
import { useEnroute, useFailedEnroute, useMessaging } from '@/lib/client/messages-hooks';
import type { MessageJob } from '@/lib/client/messages-logic';
import { useNow } from '@/lib/client/store-contract';
import { isInMedical } from '@/lib/domain';
import { ETA_CHOICES, enrouteView, iAmEnroute } from '@/lib/messaging';
import s from './messages.module.css';


// ---------------------------------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------------------------------

export interface EnrouteRowProps {
  enroute: EnrouteSummary | null;
  status: string;
  /** Tappable (mine): reopens the sheet. */
  onEdit?: () => void;
  pressed?: boolean;
  testId?: string;
}

/** The one en route row, or nothing when nobody is en route (or the request is not In medical). */
export function EnrouteRow({ enroute, status, onEdit, pressed, testId = 'enroute-row' }: EnrouteRowProps) {
  const now = useNow();
  const descId = useId();
  const view = enrouteView(enroute, now, status);
  if (!view) return null;
  const tappable = !!onEdit && view.state === 'enroute';
  // The visible pieces are hidden from screen readers. Read-only: one sentence says it all instead. Mine (a
  // button): named by exactly what it shows ("Friend en route ~5 min", WCAG 2.5.3), described by the sentence.
  const content: ReactNode = (
    <>
      {view.state === 'arrived' ? (
        <Check size={18} strokeWidth={2.25} className={s.enrIcon} aria-hidden />
      ) : (
        <WalkIcon size={18} strokeWidth={2} className={s.enrIcon} aria-hidden />
      )}
      <span className={s.enrLabel} aria-hidden>
        {view.label}
      </span>
      {view.count > 1 ? (
        <span className={s.enrCount} aria-hidden>
          {view.count}
        </span>
      ) : null}
      {view.eta ? (
        <span className={s.enrEta} aria-hidden>
          {view.eta}
        </span>
      ) : null}
      {tappable ? <ChevronRight size={16} strokeWidth={2.25} className={view.eta ? s.enrChev : `${s.enrChev} ${s.enrPush}`} aria-hidden /> : null}
    </>
  );
  if (tappable) {
    return (
      <button
        type="button"
        className={s.enr}
        data-tone={view.tone}
        data-pressed={pressed ? '' : undefined}
        data-testid={testId}
        aria-describedby={descId}
        onClick={onEdit}
      >
        {content}
        <VisuallyHidden>{[view.label, view.count > 1 ? String(view.count) : null, view.eta].filter(Boolean).join(' ')}</VisuallyHidden>
        <span id={descId} hidden>
          {`${view.sentence} Change or cancel yours.`}
        </span>
      </button>
    );
  }
  return (
    <div className={s.enr} data-tone={view.tone} data-testid={testId}>
      {content}
      <VisuallyHidden>{view.sentence}</VisuallyHidden>
    </div>
  );
}

/** What a tap that was not delivered asked for, in words (screen readers). */
function tapPhrase(job: MessageJob): string {
  switch (job.enroute?.action) {
    case 'arrive':
      return 'Arrived';
    case 'cancel':
      return 'Cancel en route';
    default:
      return 'En route';
  }
}

/**
 * "Not delivered · Retry" and Delete under the en route row (or in its place): my tap on this request failed
 * (3 tries online, or the server refused it). Retry sends it again; Delete forgets it (the row goes back
 * to what the server has).
 */
export function EnrouteFailed({ control }: { control: Pick<EnrouteControl, 'failed' | 'retry' | 'discard'> }) {
  const job = control.failed;
  if (!job) return null;
  const what = tapPhrase(job);
  return (
    <div className={s.enrFail} data-testid="enroute-failed">
      <b aria-hidden>Not delivered</b>
      <span aria-hidden>·</span>
      <button type="button" className={s.retry} onClick={control.retry} data-testid="enroute-retry" aria-label={`${what} was not delivered. Retry.`}>
        Retry
      </button>
      <IconButton
        size="2"
        variant="ghost"
        color="gray"
        className={`${s.enrFailDelete} lp-hit`}
        onClick={control.discard}
        data-testid="enroute-discard"
        aria-label={`Delete the ${what.toLowerCase()} tap that was not delivered.`}
      >
        <X size={16} strokeWidth={2} aria-hidden />
      </IconButton>
    </div>
  );
}

/** In the request's status block, under the location (updates.html v7 "1"): the row, tappable when mine. */
export function StatusEnroute({ row }: { row: RequestSummary }) {
  const control = useEnrouteControl(row);
  if (!control.available && !control.failed) return null;
  const shown = control.available && !!control.enroute;
  return (
    <>
      {shown || control.failed ? (
        <div className={s.inStatus}>
          {control.available ? (
            <EnrouteRow enroute={control.enroute} status={row.status} onEdit={control.mine ? control.openEdit : undefined} pressed={control.sheetOpen} />
          ) : null}
          <EnrouteFailed control={control} />
        </div>
      ) : null}
      {control.sheet}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------------------------------

export interface EnrouteSheetProps {
  open: boolean;
  /** 'new': Cancel / Send, nothing selected. 'edit': my ETA selected, Cancel en route / Update. */
  mode: 'new' | 'edit';
  /** My current pill (edit). */
  current: number | null;
  onClose: () => void;
  onSend: (minutes: number | null) => void;
  onCancelEnroute: () => void;
}

export function EnrouteSheet({ open, mode, current, onClose, onSend, onCancelEnroute }: EnrouteSheetProps) {
  // The pill picked in this opening of the sheet (undefined: untouched, so edit shows my current one).
  const [picked, setPicked] = useState<number | null | undefined>(undefined);
  const choice = picked === undefined ? (mode === 'edit' ? current : null) : picked;
  const changed = mode === 'edit' && picked !== undefined && picked !== current;
  const close = () => {
    setPicked(undefined);
    onClose();
  };
  return (
    <Sheet open={open} onOpenChange={(o) => (o ? undefined : close())} title="Friend en route" description="Optional: when you expect to get there.">
      <div className={s.sheetBody} data-testid="enroute-sheet" data-mode={mode}>
        <div className={s.etas} role="radiogroup" aria-label="Estimated time, optional">
          {ETA_CHOICES.map((c) => (
            <button
              key={c.minutes}
              type="button"
              role="radio"
              aria-checked={choice === c.minutes}
              aria-label={c.minutes === 0 ? 'Now' : `${c.label}, about ${c.minutes} minutes`}
              className={s.eta}
              onClick={() => setPicked(choice === c.minutes && mode === 'new' ? null : c.minutes)}
            >
              {c.label}
            </button>
          ))}
        </div>
        {mode === 'new' ? (
          <div className={s.two}>
            <Button size="3" variant="outline" color="gray" className={`${s.btn} ${s.btnQuiet}`} onClick={close}>
              Cancel
            </Button>
            <Button
              size="3"
              highContrast
              className={s.btn}
              data-testid="enroute-send"
              onClick={() => {
                const minutes = choice;
                setPicked(undefined);
                onSend(minutes);
              }}
            >
              <WalkIcon size={16} strokeWidth={2} aria-hidden />
              Send
            </Button>
          </div>
        ) : (
          <div className={s.two}>
            <Button
              size="3"
              variant="outline"
              color="red"
              className={`${s.btn} ${s.btnQuiet}`}
              data-testid="enroute-cancel"
              onClick={() => {
                setPicked(undefined);
                onCancelEnroute();
              }}
            >
              Cancel en route
            </Button>
            <Button
              size="3"
              highContrast
              className={s.btn}
              disabled={!changed}
              data-testid="enroute-update"
              onClick={() => {
                const minutes = choice;
                setPicked(undefined);
                onSend(minutes);
              }}
            >
              Update
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------------
// Controller: the row, the En route / Arrived button and the sheet for one request
// ---------------------------------------------------------------------------------------------------

export interface EnrouteControl {
  /** Effective summary (my queued tap applied). */
  enroute: EnrouteSummary | null;
  /** I am en route (not arrived) now. */
  mine: boolean;
  /** Only In medical. */
  available: boolean;
  openNew: () => void;
  openEdit: () => void;
  arrive: () => void;
  /** The sheet element to render once, anywhere in the container. */
  sheet: ReactNode;
  sheetOpen: boolean;
  /** My tap on this request that was not delivered, with Retry and Delete (EnrouteFailed). */
  failed: MessageJob | null;
  retry: () => void;
  discard: () => void;
}

export function useEnrouteControl(row: RequestSummary): EnrouteControl {
  const api = useMessaging();
  const enroute = useEnroute(row);
  const failed = useFailedEnroute(row.id);
  const [mode, setMode] = useState<'new' | 'edit' | null>(null);
  const mine = iAmEnroute(enroute);
  const available = !!api && isInMedical(row.status);
  const current = enroute?.mine?.etaMinutes ?? null;
  const sheet = available ? (
    <EnrouteSheet
      open={mode !== null}
      mode={mode ?? 'new'}
      current={current}
      onClose={() => setMode(null)}
      onSend={(minutes) => {
        setMode(null);
        void api?.setEnroute(row.id, 'set', minutes);
      }}
      onCancelEnroute={() => {
        setMode(null);
        void api?.cancelEnroute(row.id, { etaAt: enroute?.mine?.etaAt ?? null, etaMinutes: current });
      }}
    />
  ) : null;
  return {
    enroute,
    mine,
    available,
    openNew: () => setMode('new'),
    openEdit: () => setMode('edit'),
    arrive: () => void api?.setEnroute(row.id, 'arrive', null),
    sheet,
    sheetOpen: mode !== null,
    failed,
    retry: () => {
      if (failed) api?.retry(failed.id);
    },
    discard: () => {
      if (failed) void api?.discard(failed.id);
    },
  };
}
