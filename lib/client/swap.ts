// (Companion, 2026-11-08) Pure client rules for the friend swap and the companion states (spec: companion-v1 ?w=B).
// Main Med allows one companion per patient: a request Located · already accompanied may ask for a friend swap,
// the answerer approves it at the request's own post ('fa') or Main Med ('mm'), or declines it.
import type { RequestSummary } from '../api-types';
import { STATUS, postShort, type SwapPlace } from '../domain';

/**
 * The body of POST /api/requests/:id/swap without its expectedVersion (lib/validation swapSchema). 'withdraw' is the
 * requester's Undo of a request (nobody is told).
 */
export type SwapAction = { action: 'request' } | { action: 'approve'; place: SwapPlace } | { action: 'decline' } | { action: 'withdraw' } | { action: 'cancel' };
import { formatCaseNumber } from '../format';

type SwapRow = Pick<RequestSummary, 'status' | 'swapRequestedAt' | 'swapPlace'>;

/** Accompanied with an open swap request: the answerer must decide (Pending puts it on top). */
export function isSwapRequested(row: SwapRow): boolean {
  return row.status === STATUS.accompanied && !!row.swapRequestedAt;
}

/** An approved swap: In medical with the place set (until Swap done → Reunited). */
export function isSwapApproved(row: SwapRow): boolean {
  return row.status === STATUS.inMedical && (row.swapPlace === 'fa' || row.swapPlace === 'mm');
}

/** "FA 4" (the request's own tent), else that post's short name ("Command"), for a 'fa' swap; "Main Med" for 'mm'. */
export function swapPlaceLabel(place: SwapPlace, row: Pick<RequestSummary, 'reportingLocation' | 'otherLocation'> & { postShort?: string }): string {
  if (place === 'mm') return 'Main Med';
  return row.postShort || postShort(row.reportingLocation, row.otherLocation) || 'FA';
}

export const SWAP_REQUESTED_LABEL = 'Friend swap requested';
const STATUS_LABEL_ACCOMPANIED = 'Accompanied';
export const SWAP_DONE_LABEL = 'Swap done';
export const CANCEL_SWAP_REQUEST_LABEL = 'Cancel swap request';
export const CANCEL_SWAP_LABEL = 'Cancel swap';
export const SWAP_REQUEST_CANCELLED_LABEL = 'Swap request cancelled';
export const SWAP_CANCELLED_LABEL = 'Swap cancelled';

/** (Companion follow-up) What the ⋯ menu's cancel calls off: an open request, an approved swap, or nothing. */
export function swapCancelState(row: SwapRow): 'requested' | 'approved' | null {
  if (isSwapRequested(row)) return 'requested';
  if (isSwapApproved(row)) return 'approved';
  return null;
}
export const REQUEST_SWAP_LABEL = 'Request swap';
export const FRIEND_INFORMED_LABEL = 'Friend informed';
export const COMPANION_COMING_LABEL = 'Companion coming';

export function swapApprovedLabel(place: SwapPlace, row: Parameters<typeof swapPlaceLabel>[1]): string {
  return `Swap at ${swapPlaceLabel(place, row)}`;
}

/**
 * What a row shows in place of its status label: "Friend swap requested" (blue, swap glyph) or "Swap at Main Med"
 * (green, swap glyph), else null (the status's own label).
 */
export function swapDisplay(row: SwapRow & Pick<RequestSummary, 'reportingLocation' | 'otherLocation'> & { postShort?: string }): { label: string; tone: 'blue' | 'green' } | null {
  if (isSwapRequested(row)) return { label: SWAP_REQUESTED_LABEL, tone: 'blue' };
  if (isSwapApproved(row) && row.swapPlace) return { label: swapApprovedLabel(row.swapPlace, row), tone: 'green' };
  return null;
}

/** The optimistic overlay for a swap action (the server's row replaces it). */
export function swapOverlayFields(action: SwapAction, staff: string | null, nowIso: string): Partial<RequestSummary> {
  switch (action.action) {
    case 'request':
      return { swapRequestedAt: nowIso, swapRequestedBy: staff };
    case 'approve':
      return { status: STATUS.inMedical, swapPlace: action.place, swapRequestedAt: null, swapRequestedBy: null };
    case 'decline':
    case 'withdraw':
      return { swapRequestedAt: null, swapRequestedBy: null };
    case 'cancel':
      return { status: STATUS.accompanied, swapRequestedAt: null, swapRequestedBy: null, swapPlace: null };
  }
}

/** "LP-1234 · Friend swap requested" / "LP-1234 · Swap at FA 4" / "LP-1234 · Swap declined". */
export function swapToastTitle(action: SwapAction, row: Pick<RequestSummary, 'caseNumber' | 'reportingLocation' | 'otherLocation'> & { postShort?: string; swapPlace?: SwapPlace | null }): string {
  const lp = formatCaseNumber(row.caseNumber);
  if (action.action === 'request') return `${lp} · ${SWAP_REQUESTED_LABEL}`;
  if (action.action === 'approve') return `${lp} · ${swapApprovedLabel(action.place, row)}`;
  if (action.action === 'withdraw') return `${lp} · ${STATUS_LABEL_ACCOMPANIED}`;
  if (action.action === 'cancel') return `${lp} · ${row.swapPlace ? SWAP_CANCELLED_LABEL : SWAP_REQUEST_CANCELLED_LABEL}`;
  return `${lp} · Swap declined`;
}

/** The intake row on a request ("Friend · may be with them · Alex"), only while Waiting (hidden once answered). */
export function friendMayBeWith(row: Pick<RequestSummary, 'status' | 'friendInMedical' | 'friendInMedicalName'>): { name: string | null } | null {
  if (row.status !== STATUS.waiting || row.friendInMedical !== 'yes') return null;
  return { name: row.friendInMedicalName?.trim() || null };
}
