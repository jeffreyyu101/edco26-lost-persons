'use client';
// (Companion, 2026-11-08) design/screens/companion-v1.html ?w=B, screens 2 and 4.
//   LocatedSheet   Located → "Someone already with them?": No / Friend may come (green walk) · Yes / Already
//                  accompanied (amber users; outlined when the intake said a friend may be with them). Nothing
//                  saves until one is tapped.
//   SwapSheet      Friend swap requested → Swap at FA 4 (green tent) · Swap at Main Med (green cross) · Decline (grey ×).
// Also the quiet intake row (FriendMayBeRow) and the swap's "Companion coming · FA 4" row.
import { DropdownMenu } from '@radix-ui/themes';
import { Check, ChevronRight, Cross, RotateCcw, Tent, Users, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RequestSummary } from '@/lib/api-types';
import { STATUS, type SettableStatus, type StatusKind, type SwapPlace } from '@/lib/domain';
import { changeAnswerChoices } from './change-answer';
import { formatCaseNumber } from '@/lib/format';
import { COMPANION_COMING_LABEL, friendMayBeWith, swapApprovedLabel, swapPlaceLabel } from '@/lib/client/swap';
import { Sheet, SheetTitle } from '@/components/ui/Sheet';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import { WALK } from '@/components/ui/StageGlyph';
import s from './companion.module.css';

function Walk({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {WALK}
    </svg>
  );
}

function Option({
  yn,
  title,
  icon,
  tone,
  said,
  hint,
  disabled,
  testId,
  onClick,
}: {
  yn?: string;
  title: string;
  icon: ReactNode;
  tone: 'green' | 'amber' | 'gray';
  said: string;
  hint?: boolean;
  disabled?: boolean;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={s.opt}
      aria-label={said}
      aria-disabled={disabled || undefined}
      data-hint={hint ? '' : undefined}
      data-testid={testId}
      onClick={() => (disabled ? undefined : onClick())}
    >
      <span className={s.gi} data-tone={tone} aria-hidden>
        {icon}
      </span>
      <span className={s.t} aria-hidden>
        {yn ? <span className={s.yn}>{yn}</span> : null}
        <span className={s.t2}>{title}</span>
      </span>
      <span className={s.go} aria-hidden>
        <ChevronRight size={18} strokeWidth={2} />
      </span>
    </button>
  );
}

function Head({ row, sub }: { row: RequestSummary; sub: string }) {
  return (
    <div className={s.head}>
      <span className={s.hx}>
        <SheetTitle className={s.n} as="h2">
          {row.name || formatCaseNumber(row.caseNumber)}
        </SheetTitle>
        <span className={s.a}>{sub}</span>
      </span>
    </div>
  );
}

export interface LocatedSheetProps {
  row: RequestSummary | null;
  open: boolean;
  offline?: boolean;
  onClose: () => void;
  /** No → In medical (friend coming); Yes → Accompanied. */
  onChoose: (to: SettableStatus) => void;
}

/** Screen 2: the Located answer's second step. */
export function LocatedSheet({ row, open, offline, onClose, onChoose }: LocatedSheetProps) {
  if (!row) return null;
  const hinted = row.friendInMedical === 'yes';
  return (
    <Sheet open={open} onOpenChange={(o) => (o ? undefined : onClose())} titleInContent>
      <div data-testid="located-sheet">
        <Head row={row} sub={[row.age, row.gender, formatCaseNumber(row.caseNumber)].filter(Boolean).join(' · ')} />
        <div className={s.step}>
          <span className={s.chip}>
            <StatusGlyph kind="inMedical" size={12} />
            Located
          </span>
          <button type="button" className={s.change} onClick={onClose} data-testid="located-change">
            Change
          </button>
        </div>
        <div className={s.q} id="companion-q">
          Someone already with them?
        </div>
        <div className={s.opts} role="group" aria-labelledby="companion-q">
          <Option
            yn="No"
            title="Friend may come"
            icon={<Walk />}
            tone="green"
            said="No one with them: friend may come. The friend may walk over."
            disabled={offline}
            testId="located-no"
            onClick={() => onChoose(STATUS.inMedical)}
          />
          <Option
            yn="Yes"
            title="Already accompanied"
            icon={<Users size={22} strokeWidth={2} />}
            tone="amber"
            said={`Someone with them: already accompanied. The friend does not walk over.${hinted ? ' The tent said a friend may be with them.' : ''}`}
            hint={hinted}
            disabled={offline}
            testId="located-yes"
            onClick={() => onChoose(STATUS.accompanied)}
          />
        </div>
      </div>
    </Sheet>
  );
}

export interface SwapSheetProps {
  row: RequestSummary | null;
  open: boolean;
  offline?: boolean;
  /** "Dana K. · 12:31 PM": who asked and when. */
  sub?: string;
  onClose: () => void;
  onApprove: (place: SwapPlace) => void;
  onDecline: () => void;
}

/** Screen 4: the answerer decides where the swap happens, or declines it. No default. */
export function SwapSheet({ row, open, offline, sub, onClose, onApprove, onDecline }: SwapSheetProps) {
  if (!row) return null;
  const post = swapPlaceLabel('fa', row);
  return (
    <Sheet open={open} onOpenChange={(o) => (o ? undefined : onClose())} titleInContent>
      <div data-testid="swap-sheet">
        <div className={s.head}>
          <span className={s.hx}>
            <SheetTitle className={s.n} as="h2">
              Friend swap requested
            </SheetTitle>
            <span className={s.a}>{[row.name, sub].filter(Boolean).join(' · ')}</span>
          </span>
        </div>
        <div className={s.opts} role="group" aria-label="Where the swap happens">
          <Option
            title={swapApprovedLabel('fa', row)}
            icon={<Tent size={22} strokeWidth={2} />}
            tone="green"
            said={`Swap at ${post}. The companion meets the friend there.`}
            disabled={offline}
            testId="swap-fa"
            onClick={() => onApprove('fa')}
          />
          <Option
            title={swapApprovedLabel('mm', row)}
            icon={<Cross size={22} strokeWidth={2} />}
            tone="green"
            said="Swap at Main Med. The friend comes to Main Med; the companion stays until they arrive."
            disabled={offline}
            testId="swap-mm"
            onClick={() => onApprove('mm')}
          />
          <Option
            title="Decline"
            icon={<X size={22} strokeWidth={2} />}
            tone="gray"
            said="Decline the swap. The request goes back to already accompanied."
            disabled={offline}
            testId="swap-decline"
            onClick={onDecline}
          />
        </div>
      </div>
    </Sheet>
  );
}

/** Screen 1 on the request page: "Friend · may be with them · Alex", only while Waiting. */
export function FriendMayBeRow({ row }: { row: RequestSummary }) {
  const friend = friendMayBeWith(row);
  if (!friend) return null;
  return (
    <div className={s.pty} role="note" aria-label={`A friend may already be with them in medical${friend.name ? `: ${friend.name}` : ''}.`} data-testid="friend-may-be">
      <Users size={16} aria-hidden />
      <span className={s.k} aria-hidden>
        Friend
      </span>
      <span aria-hidden>·</span>
      <span aria-hidden>
        may be with them
        {friend.name ? (
          <>
            {' · '}
            <span className={s.n}>{friend.name}</span>
          </>
        ) : null}
      </span>
    </div>
  );
}

/** Screen 5 (FA swap): "Companion coming · FA 4" in place of the friend's en route row. */
export function CompanionComingRow({ row }: { row: RequestSummary }) {
  const where = swapPlaceLabel('fa', row);
  return (
    <div className={s.comp} role="note" aria-label={`The companion is coming to ${where} for the swap.`} data-testid="companion-coming">
      <span className={s.ic} aria-hidden>
        <Users size={18} strokeWidth={2} />
      </span>
      <span aria-hidden>{COMPANION_COMING_LABEL}</span>
      <span className={s.w} aria-hidden>
        {where}
      </span>
    </div>
  );
}

/**
 * (Companion) The ⋯ menu's status items for the two new statuses (the profile's and the desk pane's): Accompanied →
 * Change answer (Located · friend coming, Not located, Back to Waiting for check) and Mark discharged; Friend
 * informed → Reopen (back to Accompanied). Nothing for any other status (menuActions covers those).
 */
export function CompanionMenuItems({ status, offline, onSend }: { status: string; offline: boolean; onSend: (to: SettableStatus, kind: StatusKind) => void }) {
  if (status === STATUS.accompanied) {
    return (
      <>
        {changeAnswerChoices(status).map((c) => (
          <DropdownMenu.Item key={c.to} disabled={offline} onSelect={() => onSend(c.to, c.kind)} data-to={c.to}>
            <StatusGlyph status={c.to} size={15} />
            {c.label}
          </DropdownMenu.Item>
        ))}
        <DropdownMenu.Item disabled={offline} onSelect={() => onSend(STATUS.discharged, 'discharge')}>
          <Check size={15} aria-hidden />
          Mark discharged
        </DropdownMenu.Item>
      </>
    );
  }
  if (status === STATUS.friendInformed) {
    return (
      <DropdownMenu.Item disabled={offline} onSelect={() => onSend(STATUS.accompanied, 'reopen')}>
        <RotateCcw size={15} aria-hidden />
        Reopen
      </DropdownMenu.Item>
    );
  }
  return null;
}
