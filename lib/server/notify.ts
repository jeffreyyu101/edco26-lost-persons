// notifyStaff (contract A, the real one; F3 and F5 ship a no-op stub with this exact API). Server only.
//
// One event about a request → for every recipient but the actor (and each only once): their ONE Activity
// row for that request becomes this event, unread, at now (it moves to the top of their inbox); then a Web
// Push to each of their devices whose switch for this kind is on ("New requests" for new_request, "Updates
// on my requests" for everything else), at most one push per device.
//
//   * Never throws, and never delays the API response: the work runs after the response is sent (next/server
//     after(), which Vercel keeps alive with waitUntil). Where after() is not available (a test calling it
//     directly), the caller waits at most NOTIFY_WAIT_MS and the rest finishes in the background.
//   * Logs only a code and counts (no staff, names, endpoints or text).
//   * The push title is the request's full name (lib/domain.ts alertName; "New request" for a new one); the body is the detail
//     (contract B), scrubbed of request ids and phone numbers once more.
import 'server-only';
import { after } from 'next/server';
import {
  SWAP_CANCELLED_DETAIL,
  SWAP_DECLINED_DETAIL,
  SWAP_REQUEST_CANCELLED_DETAIL,
  isActivityKind,
  pushPayload,
  pushTtl,
  pushUrgency,
  requestTitle,
  scrubDetail,
  swapApprovedDetail,
  swapRequestedDetail,
  type ActivityEvent,
} from '../activity';
import type { RequestSummary } from '../api-types';
import { isUuid, sameStaff } from '../domain';
import { involvedStaff } from './involved';
import { groupOutcomes, pushEnabled, sendPushes, type PushTarget } from './push';
import { rpc } from './supabase';
import { recordPushSend } from './telemetry';

export type { ActivityEvent, ActivityKind } from '../activity';

/** The longest a caller ever waits for a notification when it cannot run after the response. */
export const NOTIFY_WAIT_MS = 1_500;

function log(code: string, counts: Record<string, number> = {}): void {
  console.warn(JSON.stringify({ lp: 'notify', code, ...counts }));
}

interface Recorded {
  written?: unknown;
  targets?: unknown;
  unread?: unknown;
  firstName?: unknown;
  lastName?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function targetsOf(value: unknown): PushTarget[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((t) => {
    const r = t as Record<string, unknown> | null;
    const endpoint = str(r?.endpoint);
    const p256dh = str(r?.p256dh);
    const auth = str(r?.auth);
    const staff = str(r?.staff);
    return endpoint && p256dh && auth && staff ? [{ endpoint, p256dh, auth, staff }] : [];
  });
}

/** Records the event and pushes it. Resolves when everything is done; never rejects. */
export async function deliver(eventId: string, recipients: readonly string[], event: ActivityEvent): Promise<void> {
  try {
    if (!isUuid(event.requestId) || !isActivityKind(event.kind)) {
      log('bad_event');
      return;
    }
    const list = [...new Set(recipients.filter((r) => typeof r === 'string' && r.trim() !== ''))];
    if (list.length === 0) return;
    const detail = scrubDetail(event.detail ?? '');
    const data = await rpc<Recorded | null>('lp_activity_record', {
      p_event: eventId,
      p_recipients: list,
      p_request: event.requestId,
      p_kind: event.kind,
      p_actor: event.actor ?? '',
      p_detail: detail,
    });
    const targets = targetsOf(data?.targets);
    if (targets.length === 0 || !pushEnabled()) return;
    const title = requestTitle(str(data?.firstName), str(data?.lastName));
    const unread = (data?.unread && typeof data.unread === 'object' ? data.unread : {}) as Record<string, unknown>;
    const sendStarted = performance.now();
    const outcomes = await sendPushes(
      targets,
      (t) => pushPayload({ requestId: event.requestId, kind: event.kind, detail }, title, typeof unread[t.staff] === 'number' ? (unread[t.staff] as number) : null),
      { ttl: pushTtl(event.kind), urgency: pushUrgency(event.kind) },
    );
    const grouped = groupOutcomes(outcomes);
    if (grouped.gone.length || grouped.failed.length) log('push_partial', { ok: grouped.ok.length, gone: grouped.gone.length, failed: grouped.failed.length });
    await rpc('lp_push_result', { p_ok: grouped.ok, p_gone: grouped.gone, p_failed: grouped.failed });
    // Telemetry (push_send per team: counts and the round's duration). Never throws, writes nothing when collection is off.
    await recordPushSend(eventId, event.kind, targets, outcomes, performance.now() - sendStarted);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    log(typeof code === 'string' ? `failed_${code.replace(/[^a-z_]/gi, '').slice(0, 30)}` : 'failed');
  }
}

/**
 * Runs `task` after the response is sent. Outside a request (tests, scripts) it runs now, and the caller
 * waits at most NOTIFY_WAIT_MS for it.
 */
export async function afterResponse(task: () => Promise<void>): Promise<void> {
  try {
    after(task);
    return;
  } catch {
    // not inside a request: run it here, bounded
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = task().catch(() => undefined);
  await Promise.race([run, new Promise<void>((resolve) => (timer = setTimeout(resolve, NOTIFY_WAIT_MS)))]);
  clearTimeout(timer);
}

/** Contract A. Records the event for `recipients` (minus the actor) and pushes it. Never throws. */
export async function notifyStaff(eventId: string, recipients: readonly string[], event: ActivityEvent): Promise<void> {
  await afterResponse(() => deliver(eventId, recipients, event));
}

/**
 * The same, with the recipients looked up after the response too (involvedStaff, newRequestStaff), so the
 * lookup never costs the caller time either.
 */
export async function notifyLater(
  eventId: string,
  recipients: () => Promise<readonly string[]>,
  event: () => Promise<ActivityEvent | null> | ActivityEvent | null,
): Promise<void> {
  await afterResponse(async () => {
    try {
      const e = await event();
      if (!e) return;
      await deliver(eventId, await recipients(), e);
    } catch {
      log('failed_lookup');
    }
  });
}

/** (Companion) Who lp_swap says took part: the answerer (request), the requester and the creator (decline). */
export interface SwapParties {
  answerer: string | null;
  requester: string | null;
  creator: string | null;
  /**
   * (Companion) cancel: what was cancelled, 'requested' (an open request) or 'approved' (a running swap).
   * (Post-event) restore: what came back.
   */
  from?: 'requested' | 'approved' | null;
  /** (Post-event) restore: the step it took back ('swap_cancelled' | 'swap_declined' | 'swap_approved'). */
  undid?: string | null;
}

export type SwapNoticeAction = 'request' | 'approve' | 'decline' | 'withdraw' | 'cancel' | 'restore';

/**
 * (Companion) The event and recipients of a friend swap change (spec table), or null (nobody is told):
 *   request  → THE STAFF WHO ANSWERED (latest change into Accompanied / Located), else everyone involved
 *   approve  → everyone involved (the requester is: lp_involved_staff counts swap_requested)
 *   decline  → the requester and the creator
 *   cancel   → from requested: the staff who answered (as request); from approved: everyone involved
 *   withdraw → (post-event) as cancel from requested: their push asked them to decide
 *   restore  → (post-event) the Undo of the caller's own step: an approval back → "Swap at …" to everyone involved;
 *              an approval taken back → "Swap cancelled" to everyone involved; a cancelled request back → "Friend
 *              swap requested" to whoever the cancel told; a declined request back → nobody (the next decision tells them)
 * The actor is always left out (lp_activity_record). `recipients` null = everyone involved. (Post-event) The staff
 * who answered counts only when it is someone else: the actor alone would leave nobody to tell.
 */
export function swapEvent(
  action: SwapNoticeAction,
  row: Pick<RequestSummary, 'id' | 'postShort' | 'swapPlace'>,
  actor: string,
  parties: SwapParties,
  mainMedical = '',
): { recipients: string[] | null; event: ActivityEvent } | null {
  const base = { requestId: row.id, actor };
  const answerer = parties.answerer && !sameStaff(parties.answerer, actor) ? [parties.answerer] : null;
  const requested: ActivityEvent = { ...base, kind: 'swap_requested', detail: swapRequestedDetail(row.postShort) };
  if (action === 'restore') {
    if (parties.undid === 'swap_approved') return { recipients: null, event: { ...base, kind: 'swap_cancelled', detail: SWAP_CANCELLED_DETAIL } };
    // A cancelled request back goes to whoever the cancel told (the answerer, else everyone involved).
    if (parties.from !== 'approved') return parties.undid === 'swap_cancelled' ? { recipients: answerer, event: requested } : null;
    action = 'approve';
  }
  if (action === 'request') return { recipients: answerer, event: requested };
  if (action === 'approve') {
    const place = row.swapPlace === 'fa' ? 'fa' : 'mm';
    return { recipients: null, event: { ...base, kind: 'swap_approved', detail: swapApprovedDetail(place, row.postShort, mainMedical) } };
  }
  if (action === 'decline') {
    const list = [parties.requester, parties.creator].filter((s): s is string => !!s);
    return { recipients: list, event: { ...base, kind: 'swap_declined', detail: SWAP_DECLINED_DETAIL } };
  }
  if (action === 'withdraw' || action === 'cancel') {
    if (action === 'withdraw' || parties.from === 'requested') {
      return { recipients: answerer, event: { ...base, kind: 'swap_cancelled', detail: SWAP_REQUEST_CANCELLED_DETAIL } };
    }
    return { recipients: null, event: { ...base, kind: 'swap_cancelled', detail: SWAP_CANCELLED_DETAIL } };
  }
  return null;
}

/** (Companion) Records and pushes a friend swap change after the response. Never throws. */
export async function swapNotice(
  eventId: string,
  action: SwapNoticeAction,
  row: Pick<RequestSummary, 'id' | 'postShort' | 'swapPlace'>,
  actor: string,
  mainMedical: string,
  parties: SwapParties,
): Promise<void> {
  const plan = swapEvent(action, row, actor, parties, mainMedical);
  if (!plan) return;
  const fixed = plan.recipients;
  await notifyLater(eventId, () => (fixed ? Promise.resolve(fixed) : involvedStaff(eventId, row.id)), () => plan.event);
}
