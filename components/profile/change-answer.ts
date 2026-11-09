// Change answer on the profile (design/DECISIONS.md v2.2 "Change answer and Undo", Brian + Jeffrey 2026-11-06:
// "if someone accidentally sets an in medical state then it's easy to undo and also set back to pending").
// The button opens a small menu: the other answer, then Back to Waiting for check. Each choice is one
// lp_set_status move with kind 'change', so it gets the store's optimistic overlay, its audit row and the
// Undo bar like every other answer. Pure: no React, no I/O (tests/unit/profile/change-answer.test.ts).
import { ANSWER_LABEL, STATUS, STATUS_META, canTransition, isInMedical, statusMeta, type SettableStatus, type StatusKind } from '@/lib/domain';

export interface ChangeChoice {
  /** Where the tap moves the request. */
  to: SettableStatus;
  /** The menu item's text: the answer button's ("Not found", "In medical"), or "Back to Waiting for check". */
  label: string;
  kind: Extract<StatusKind, 'change'>;
}

export const BACK_TO_WAITING = `Back to ${statusMeta(STATUS.waiting).shortLabel}`;

/**
 * The Change answer menu for a status, in display order. In medical (legacy Bring friend included) offers
 * Not found, Not found in medical offers In medical, and both offer Back to Waiting for check. Only moves
 * lp_set_status allows are listed (legacy Bring friend → Added is not one), and every other status has none.
 * The answers read as the answer buttons do (ANSWER_LABEL).
 */
export function changeAnswerChoices(status: string): ChangeChoice[] {
  // (Companion) Already accompanied: Located · friend coming, Not located, Back to Waiting for check.
  if (status === STATUS.accompanied) {
    return [
      { to: STATUS.inMedical, label: STATUS_META[STATUS.inMedical].label, kind: 'change' as const },
      { to: STATUS.notInMedical, label: ANSWER_LABEL.notFound, kind: 'change' as const },
      { to: STATUS.waiting, label: BACK_TO_WAITING, kind: 'change' as const },
    ].filter((c) => canTransition(status, c.to));
  }
  const other: SettableStatus | null = isInMedical(status) ? STATUS.notInMedical : status === STATUS.notInMedical ? STATUS.inMedical : null;
  if (other === null) return [];
  const choices: ChangeChoice[] = [
    { to: other, label: other === STATUS.notInMedical ? ANSWER_LABEL.notFound : ANSWER_LABEL.inMedical, kind: 'change' },
    // (Post-event) Located · friend coming → already accompanied (the way back from it is offered above).
    ...(status === STATUS.inMedical ? [{ to: STATUS.accompanied, label: STATUS_META[STATUS.accompanied].label, kind: 'change' as const }] : []),
    { to: STATUS.waiting, label: BACK_TO_WAITING, kind: 'change' },
  ];
  return choices.filter((c) => canTransition(status, c.to));
}
