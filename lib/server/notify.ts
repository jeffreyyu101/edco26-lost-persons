// notifyStaff (F3/F4/F5 contract A). NO-OP stub: replaced by F4, which owns the real file (Activity rows +
// Web Push). F3 calls it after every successful message / en route write with the request's involved staff
// (contract D); the stub keeps the exact API so the call sites merge unchanged. Server only.
import 'server-only';

export type ActivityKind =
  | 'message'
  | 'enroute'
  | 'enroute_changed'
  | 'enroute_cancelled'
  | 'arrived'
  | 'new_request'
  | 'in_medical'
  | 'not_in_medical'
  | 'back_to_waiting'
  | 'moved'
  | 'reunited'
  | 'discharged'
  | 'cancelled'
  | 'edited';

export interface ActivityEvent {
  requestId: string;
  kind: ActivityKind;
  actor: string;
  detail: string;
}

/** Contract A. Never throws; never delays the API response by more than 1.5 s. Replaced by F4. */
export async function notifyStaff(recipients: readonly string[], event: ActivityEvent): Promise<void> {
  void recipients;
  void event;
}
