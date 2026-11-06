// Recovers 409 / 422 when PostgREST could not render the database error (OPAQUE_DB_ERROR, see
// lib/server/supabase.ts). The function's transaction rolled back, so the row as it is now tells which of
// its status-carrying raises fired:
//   lp_set_status:    version mismatch → P0409, else (transition not allowed) → P0422 illegal_transition
//   lp_update_fields: version mismatch → P0409
//   lp_cancel:        status not Added → P0422 illegal_transition (checked first), else version → P0409
// Anything that does not fit stays a 503 (the client retries). Server only.
import 'server-only';
import { STATUS, canTransition } from '../domain';
import { ApiFailure } from './errors';
import { OPAQUE_DB_ERROR, db } from './supabase';

export type MutationKind =
  | { fn: 'status'; expectedVersion: number; target: string }
  | { fn: 'update'; expectedVersion: number }
  | { fn: 'cancel'; expectedVersion: number };

async function currentRow(id: string): Promise<{ status: string; row_version: number } | null | 'error'> {
  try {
    const { data, error } = await db().from('patients').select('status, row_version').eq('id', id).maybeSingle();
    if (error) return 'error';
    if (!data) return null;
    const row = data as { status: unknown; row_version: unknown };
    return { status: String(row.status), row_version: Number(row.row_version) };
  } catch {
    return 'error';
  }
}

const conflict = (status: string) => new ApiFailure('conflict', undefined, { dbCode: 'P0409_reclassified', extra: { currentStatus: status.slice(0, 60) } });
const illegal = (status: string) =>
  new ApiFailure('invalid', "That change isn't allowed from the current status", { dbCode: 'P0422_reclassified', extra: { currentStatus: status.slice(0, 60) } });

/** Returns `failure` unchanged unless it is an opaque database error that the row explains. */
export async function reclassify(failure: unknown, id: string, kind: MutationKind): Promise<unknown> {
  if (!(failure instanceof ApiFailure) || failure.dbCode !== OPAQUE_DB_ERROR) return failure;
  const row = await currentRow(id);
  if (row === 'error') return failure;
  if (row === null) return new ApiFailure('not_found', undefined, { dbCode: 'P0002_reclassified' });
  switch (kind.fn) {
    case 'status':
      if (row.row_version !== kind.expectedVersion) return conflict(row.status);
      if (row.status !== kind.target && !canTransition(row.status, kind.target)) return illegal(row.status);
      return failure;
    case 'update':
      return row.row_version !== kind.expectedVersion ? conflict(row.status) : failure;
    case 'cancel':
      if (row.status !== STATUS.waiting && row.status !== STATUS.cancelled) return illegal(row.status);
      if (row.row_version !== kind.expectedVersion) return conflict(row.status);
      return failure;
  }
}

/** Runs a mutation RPC call, reclassifying an opaque failure from the row. */
export async function withReclassify<T>(id: string, kind: MutationKind, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw await reclassify(error, id, kind);
  }
}
