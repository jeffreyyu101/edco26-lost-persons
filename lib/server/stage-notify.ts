// F5 (contract D): the not_in_medical notification. Both Not found answers tell everyone involved in the request
// (lib/server/involved.ts) through notifyStaff (lib/server/notify.ts, F4's): the first one, which puts the
// request on a "Not found yet" hold, and the final one. The detail is line 2 of the Activity row and the push
// body (contract B): "Not found yet · recheck 4:40 PM", or the closed status's own label from STATUS_META (so a
// renamed label flows through). Nouns only: never a name, phone number or id. Server only.
import 'server-only';
import type { RequestSummary } from '../api-types';
import { STATUS, canonStaff, holdDetail, isHeld, statusMeta } from '../domain';
import { eventTimezone } from './env';
import { involvedStaff } from './involved';
import { notifyStaff, type ActivityEvent } from './notify';

/** The detail of a Not found answer, from the row the answer returned; null when it is neither. */
export function notFoundDetail(row: Pick<RequestSummary, 'status' | 'recheckAt'>, timeZone: string): string | null {
  if (isHeld(row)) return holdDetail(row.recheckAt, timeZone);
  if (row.status === STATUS.notInMedical) return statusMeta(row.status).label;
  return null;
}

/** Tells everyone involved (but the actor) that `row` was answered Not found. Never throws. */
export async function notifyNotFound(row: RequestSummary, actorStaff: string): Promise<void> {
  try {
    const detail = notFoundDetail(row, eventTimezone());
    if (!detail) return;
    const recipients = await involvedStaff(row.id);
    const event: ActivityEvent = { requestId: row.id, kind: 'not_in_medical', actor: canonStaff(actorStaff) ?? actorStaff, detail };
    await notifyStaff(recipients, event);
  } catch {
    console.warn(JSON.stringify({ lp: 'notify', code: 'not_found_failed' }));
  }
}
