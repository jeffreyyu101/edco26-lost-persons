// replaced by F4. A NO-OP stub of the shared notify contract (F3 / F4 / F5 contract A), so the status route can
// call it on this branch. F4's real file upserts the Activity row and sends the Web Push; it never throws and
// never holds the API response for more than 1.5 s. Server only.
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

export async function notifyStaff(recipients: readonly string[], event: ActivityEvent): Promise<void> {
  void recipients;
  void event;
}
