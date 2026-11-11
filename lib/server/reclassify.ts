// Recovers 409 / 422 when PostgREST could not render the database error (OPAQUE_DB_ERROR, see
// lib/server/supabase.ts). The function's transaction rolled back, so the row as it is now tells which of
// its status-carrying raises fired:
//   lp_set_status:    version mismatch → P0409, else (transition not allowed) → P0422 illegal_transition
//   lp_update_fields: version mismatch → P0409
//   lp_cancel:        status not Added → P0422 illegal_transition (checked first), else version → P0409
// Anything that does not fit stays a 503 (the client retries). (Events) The row is read within the caller's event only:
// another event's request reads as missing. Server only.
import 'server-only';
import { STATUS, canTransition, isInMedical, type StatusKind } from '../domain';
import { ApiFailure } from './errors';
import { OPAQUE_DB_ERROR, db } from './supabase';

export type MutationKind =
  | { fn: 'status'; expectedVersion: number; target: string; kind?: StatusKind }
  | { fn: 'update'; expectedVersion: number }
  | { fn: 'cancel'; expectedVersion: number }
  // (Companion) lp_swap: version mismatch → P0409, else (not Accompanied) → P0422 illegal_transition. (Post-event)
  // cancel and restore also start from an approved swap (In medical + swap_place): left a 503 there.
  | { fn: 'swap'; expectedVersion: number; action: string };

async function currentRow(eventId: string, id: string): Promise<{ status: string; row_version: number; swap_place: unknown } | null | 'error'> {
  try {
    const { data, error } = await db().from('patients').select('status, row_version, swap_place').eq('id', id).eq('event_id', eventId).maybeSingle();
    if (error) return 'error';
    if (!data) return null;
    const row = data as { status: unknown; row_version: unknown; swap_place?: unknown };
    return { status: String(row.status), row_version: Number(row.row_version), swap_place: row.swap_place ?? null };
  } catch {
    return 'error';
  }
}

const conflict = (status: string) => new ApiFailure('conflict', undefined, { dbCode: 'P0409_reclassified', extra: { currentStatus: status.slice(0, 60) } });
const illegal = (status: string) =>
  new ApiFailure('invalid', "That change isn't allowed from the current status", { dbCode: 'P0422_reclassified', extra: { currentStatus: status.slice(0, 60) } });

/** Returns `failure` unchanged unless it is an opaque database error that the row explains. */
export async function reclassify(failure: unknown, eventId: string, id: string, kind: MutationKind): Promise<unknown> {
  if (!(failure instanceof ApiFailure) || failure.dbCode !== OPAQUE_DB_ERROR) return failure;
  const row = await currentRow(eventId, id);
  if (row === 'error') return failure;
  if (row === null) return new ApiFailure('not_found', undefined, { dbCode: 'P0002_reclassified' });
  switch (kind.fn) {
    case 'status':
      if (row.row_version !== kind.expectedVersion) return conflict(row.status);
      if (row.status !== kind.target && !canTransition(row.status, kind.target, kind.kind)) return illegal(row.status);
      // (Post-event) A Reopen to Accompanied passes the table, but lp_set_status also refuses it for a request closed
      // from Located; with the version matching, that is the only raise left.
      if (row.status === STATUS.inactive && kind.target === STATUS.accompanied) return illegal(row.status);
      return failure;
    case 'update':
      return row.row_version !== kind.expectedVersion ? conflict(row.status) : failure;
    case 'cancel':
      if (row.status !== STATUS.waiting && row.status !== STATUS.cancelled) return illegal(row.status);
      if (row.row_version !== kind.expectedVersion) return conflict(row.status);
      return failure;
    case 'swap':
      if (row.row_version !== kind.expectedVersion) return conflict(row.status);
      if ((kind.action === 'cancel' || kind.action === 'restore') && isInMedical(row.status) && row.swap_place) return failure;
      if (row.status !== STATUS.accompanied) return illegal(row.status);
      return failure;
  }
}

/** Runs a mutation RPC call, reclassifying an opaque failure from the row. */
export async function withReclassify<T>(eventId: string, id: string, kind: MutationKind, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw await reclassify(error, eventId, id, kind);
  }
}
