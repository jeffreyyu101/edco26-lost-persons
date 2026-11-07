// F6 (spec §24 A100): the inactivity auto-close tells everyone involved in the request, once per close, through F4's
// notifyStaff path (Activity row + Web Push, kind 'closed_inactive', detail "Closed · inactive"). The close itself is
// SQL on a timer (lp_close_inactive, the pg_cron job), which can't send a push, so the app server tells: no new
// infrastructure. GET /api/sync already returns every newly closed row to every open phone (the close bumps
// row_version); when a page holds one closed in the last few minutes, the sync handler claims it after the response
// (lp_inactive_claim marks it told in the same statement, so of many phones syncing at once exactly one tells it)
// and delivers it. A backlog close (idle well past the limit) is never told (lp_close_inactive marks it at once).
// Never throws; logs only a code and counts. Server only.
import 'server-only';
import { inactiveDetail } from '../activity';
import type { RequestSummary } from '../api-types';
import { SYSTEM_STAFF, isInactiveClosed, isUuid } from '../domain';
import { involvedStaff } from './involved';
import { deliver } from './notify';
import { rpc } from './supabase';

/** How long after a close the sync still tells it (matches lp_inactive_claim's window). */
export const INACTIVE_NOTIFY_WINDOW_MS = 15 * 60_000;
/** lp_inactive_claim takes at most this many ids. */
const MAX_IDS = 200;

function log(code: string, counts: Record<string, number> = {}): void {
  console.warn(JSON.stringify({ lp: 'notify', code, ...counts }));
}

/**
 * The rows of a sync answer that an auto-close may still have to tell: Closed · inactive within the window, never
 * a backlog close (quietClose: lp_close_inactive marked it told already).
 */
export function inactiveCandidates(rows: readonly Pick<RequestSummary, 'id' | 'status' | 'closedAt' | 'quietClose'>[], now: number = Date.now()): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (!isInactiveClosed(row.status) || !isUuid(row.id) || row.quietClose === true) continue;
    const at = row.closedAt ? Date.parse(row.closedAt) : NaN;
    if (Number.isFinite(at) && now - at <= INACTIVE_NOTIFY_WINDOW_MS && at - now <= 60_000) out.push(row.id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

/** Claims the closes of `ids` not told yet and tells each one to everyone involved. Resolves when done; never rejects. */
export async function notifyInactiveCloses(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  let claimed: string[] = [];
  try {
    const data = await rpc<unknown>('lp_inactive_claim', { p_ids: [...new Set(ids)].slice(0, MAX_IDS) });
    claimed = Array.isArray(data) ? data.filter((id): id is string => isUuid(id)) : [];
  } catch {
    // A database before F6 (no lp_inactive_claim), or a blip: the next sync tries again within the window.
    log('inactive_claim_failed');
    return;
  }
  const detail = inactiveDetail();
  for (const requestId of claimed) {
    try {
      await deliver(await involvedStaff(requestId), { requestId, kind: 'closed_inactive', actor: SYSTEM_STAFF, detail });
    } catch {
      log('inactive_notify_failed');
    }
  }
}
