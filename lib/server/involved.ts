// replaced by F4 (contract C: F4 owns lib/server/involved.ts; F5 ships this stub with the same API).
// Who a request's notifications go to: public.lp_involved_staff(p_request) (F3's function: the logger, who
// answered, who set the location, everyone who messaged, everyone en route), as canonical staff strings
// (domain.canonStaff). Where the function does not exist yet (PGRST202 / 42883), the logger and whoever
// answered it. Never throws: on any other failure it returns []. Server only.
import 'server-only';
import { canonStaff } from '../domain';
import { db, rpc } from './supabase';
import { ApiFailure } from './errors';

const MISSING_FUNCTION = new Set(['PGRST202', '42883']);

function canonList(values: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    const c = typeof v === 'string' ? canonStaff(v) : null;
    if (c) out.add(c);
  }
  return [...out];
}

/** The logger and every staff member who changed the request's status (the fallback). */
async function loggerAndAnswerers(requestId: string): Promise<string[]> {
  const client = db();
  const [patient, events] = await Promise.all([
    client.from('patients').select('created_by').eq('id', requestId).maybeSingle(),
    client.from('audit_events').select('staff_name').eq('patient_id', requestId).eq('action_type', 'status_changed'),
  ]);
  const values: unknown[] = [];
  const createdBy = (patient.data as { created_by?: unknown } | null)?.created_by;
  if (createdBy) values.push(createdBy);
  for (const e of (events.data as Array<{ staff_name?: unknown }> | null) ?? []) values.push(e.staff_name);
  return canonList(values);
}

export async function involvedStaff(requestId: string): Promise<string[]> {
  try {
    const data = await rpc<unknown>('lp_involved_staff', { p_request: requestId });
    const rows = Array.isArray(data) ? data : [];
    // setof text arrives as a list of strings (or of {lp_involved_staff: text} rows on some PostgREST setups).
    return canonList(rows.map((r) => (r && typeof r === 'object' ? Object.values(r as Record<string, unknown>)[0] : r)));
  } catch (error) {
    if (error instanceof ApiFailure && error.dbCode && MISSING_FUNCTION.has(error.dbCode)) {
      try {
        return await loggerAndAnswerers(requestId);
      } catch {
        return [];
      }
    }
    return [];
  }
}
