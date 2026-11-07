// The Activity event of an edit (F4, spec §18 A57), read after the response from the audit row the edit
// just wrote (lp_update_fields records the changed keys with their old and new values). Server only.
import 'server-only';
import { editEvent, type ActivityEvent } from '../activity';
import { db } from './supabase';

/** The edit event for `requestId` by `actor`: "In medical · Chair 9", "Chair 9 → Bed 3" or "Details changed". */
export async function editEventFor(requestId: string, actor: string, status: string): Promise<ActivityEvent> {
  let keys: string[] = [];
  let previous: string | null = null;
  let next: string | null = null;
  try {
    const { data } = await db()
      .from('audit_events')
      .select('previous_value, new_value')
      .eq('patient_id', requestId)
      .eq('action_type', 'patient_updated')
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = data as { previous_value?: unknown; new_value?: unknown } | null;
    const nv = row?.new_value && typeof row.new_value === 'object' ? (row.new_value as Record<string, unknown>) : {};
    const pv = row?.previous_value && typeof row.previous_value === 'object' ? (row.previous_value as Record<string, unknown>) : {};
    keys = Object.keys(nv);
    next = typeof nv.medical_location === 'string' ? nv.medical_location : null;
    previous = typeof pv.medical_location === 'string' ? pv.medical_location : null;
  } catch {
    // unknown: "Details changed"
  }
  return { requestId, actor, ...editEvent(keys, previous, next, status) };
}
