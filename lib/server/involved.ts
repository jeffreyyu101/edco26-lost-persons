// Who is involved in a request (contract C). Server only.
//
// public.lp_involved_staff(p_request uuid) returns setof text is owned by the Messages release (F3): the
// logger, whoever answered In medical / Not found, whoever set the location, everyone who messaged and
// everyone en route. Until it is there (PGRST202 "function not found" / 42883), or if it fails for any other
// reason, the fallback is lp_activity_fallback_staff: whoever logged the request and whoever answered it.
// A notification is never lost because the richer list could not be read.
import 'server-only';
import { db, rpc } from './supabase';

/** Attribution or canonical staff strings out of a PostgREST answer (setof text, or rows of one column). */
export function staffList(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const item of data) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object') {
      const values = Object.values(item as Record<string, unknown>);
      if (values.length === 1 && typeof values[0] === 'string') out.push(values[0]);
    }
  }
  return out.filter((s) => s.trim() !== '');
}

/** Logger + answerers (lp_activity_fallback_staff). Never throws. */
export async function fallbackStaff(eventId: string, requestId: string): Promise<string[]> {
  try {
    return staffList(await rpc<unknown>('lp_activity_fallback_staff', { p_event: eventId, p_request: requestId }));
  } catch {
    return [];
  }
}

/** Everyone involved in the request (attribution strings). Never throws. */
export async function involvedStaff(eventId: string, requestId: string): Promise<string[]> {
  try {
    const { data, error } = await db().rpc('lp_involved_staff', { p_event: eventId, p_request: requestId });
    if (!error) {
      const list = staffList(data);
      // The richer list always includes the logger; an empty answer means something is off: fall back.
      if (list.length > 0) return list;
    }
  } catch {
    // network or timeout: the fallback below tries again
  }
  return fallbackStaff(eventId, requestId);
}

/** Everyone in the event whose "New requests" switch is on (canonical staff strings). Never throws. */
export async function newRequestStaff(eventId: string): Promise<string[]> {
  try {
    return staffList(await rpc<unknown>('lp_push_new_request_staff', { p_event: eventId }));
  } catch {
    return [];
  }
}
