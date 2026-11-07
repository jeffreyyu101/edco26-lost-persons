// Messages and en route on the server (F3, spec §18 A53–A58): the lp_messages_* / lp_enroute JSON →
// API DTOs, the activity /api/sync and the detail attach to rows, and the notification after a write.
// Every field goes through an explicit allowlist, like lib/server/mappers.ts. Server only.
//
// Decoration never breaks the call it decorates: when lp_messages_sync / lp_messages_thread fail (a
// database without section 7, a timeout), the rows go out without activity and the client keeps what it
// had (sync-merge carryActivity). Failures log a code only.
import 'server-only';
import type {
  EnrouteSummary,
  LastMessage,
  RequestActivityDto,
  RequestSummary,
  SyncResponse,
  ThreadMessage,
  ThreadPage,
} from '../api-types';
import { parseStaff } from '../domain';
import { DETAIL, EMPTY_ACTIVITY, enrouteDetail, messageDetail, senderShort, truncateText, MESSAGE_PREVIEW_MAX } from '../messaging';
import { mapRow } from './mappers';
import { notifyStaff, type ActivityEvent, type ActivityKind } from './notify';
import { rpc } from './supabase';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const reqStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);

/** One warning line, a code only (never names, bodies or ids). */
function logSoft(code: string): void {
  console.warn(JSON.stringify({ lp: 'messages', code: code.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) }));
}

// ---------------------------------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------------------------------

/** lp_enroute_summary JSON → EnrouteSummary (null when nobody is en route). */
export function mapEnroute(raw: unknown): EnrouteSummary | null {
  if (!isObject(raw)) return null;
  const state = raw.state === 'arrived' ? 'arrived' : raw.state === 'enroute' ? 'enroute' : null;
  if (!state) return null;
  const m = isObject(raw.mine) ? raw.mine : null;
  const minutes = m && typeof m.eta_minutes === 'number' && Number.isFinite(m.eta_minutes) ? m.eta_minutes : null;
  return {
    count: int(raw.count),
    earliestEta: str(raw.earliest_eta),
    state,
    mine: m
      ? { etaAt: str(m.eta_at), etaMinutes: minutes, state: m.state === 'arrived' ? 'arrived' : 'enroute' }
      : null,
  };
}

function mapLastMessage(raw: unknown): LastMessage | null {
  if (!isObject(raw)) return null;
  return {
    by: senderShort(reqStr(raw.staff)),
    mine: raw.mine === true,
    text: truncateText(reqStr(raw.body), MESSAGE_PREVIEW_MAX),
  };
}

/** lp_messages_activity JSON → the RequestSummary activity fields. */
export function mapActivity(raw: unknown): RequestActivityDto {
  if (!isObject(raw)) return { ...EMPTY_ACTIVITY };
  return {
    messageCount: int(raw.message_count),
    lastMessageAt: str(raw.last_message_at),
    unread: int(raw.unread),
    needsInfo: raw.needs_info === true,
    lastMessage: mapLastMessage(raw.last_message),
    enroute: mapEnroute(raw.enroute),
    involved: raw.involved === true,
  };
}

/** lp_messages_json → ThreadMessage. */
export function mapMessage(raw: unknown): ThreadMessage {
  const m = isObject(raw) ? raw : {};
  const staff = reqStr(m.staff);
  const parsed = parseStaff(staff);
  return {
    id: reqStr(m.id),
    staff,
    by: senderShort(staff),
    team: parsed.teamShort || parsed.team,
    body: reqStr(m.body),
    createdAt: reqStr(m.created_at),
    mine: m.mine === true,
    clientMutationId: reqStr(m.client_mutation_id),
  };
}

/** lp_messages_thread JSON → ThreadPage. */
export function mapThread(raw: unknown): ThreadPage {
  const t = isObject(raw) ? raw : {};
  const receipt = isObject(t.receipt) && typeof t.receipt.message_id === 'string'
    ? { messageId: t.receipt.message_id, readAt: str(t.receipt.read_at) }
    : null;
  return {
    messages: Array.isArray(t.messages) ? t.messages.map(mapMessage) : [],
    hasEarlier: t.has_earlier === true,
    receipt,
    activity: mapActivity(t.activity),
  };
}

/** A row with its activity fields set. */
export function withActivity(row: RequestSummary, activity: RequestActivityDto): RequestSummary {
  return { ...row, ...activity };
}

/** lp_* `recipients` (canonical staff strings). */
export function recipientsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
}

// ---------------------------------------------------------------------------------------------------
// Decoration
// ---------------------------------------------------------------------------------------------------

export interface DecorateOptions {
  staff: string;
  /** The delta cursor; with `changed`, requests whose thread changed since (− 30 s) are added. */
  since: string | null;
  /** Add changed threads (the first page of a delta poll only). */
  changed: boolean;
}

/**
 * Sync rows with their activity, plus the rows whose thread changed without their patients row changing
 * (a message, an unsend, an en route, my read on another phone). On failure the rows go out as they are.
 */
export async function decorateSync(sync: SyncResponse, opts: DecorateOptions): Promise<SyncResponse> {
  const ids = sync.rows.map((r) => r.id).filter(Boolean);
  if (ids.length === 0 && !(opts.changed && opts.since)) return sync;
  let data: unknown;
  try {
    data = await rpc<unknown>('lp_messages_sync', {
      p_staff: opts.staff,
      p_ids: ids,
      p_since: opts.since,
      p_changed: opts.changed && !!opts.since,
    });
  } catch (error) {
    logSoft((error as { dbCode?: string } | null)?.dbCode ?? 'sync_activity_failed');
    return sync;
  }
  const d = isObject(data) ? data : {};
  const byId = new Map<string, RequestActivityDto>();
  for (const t of Array.isArray(d.threads) ? d.threads : []) {
    if (isObject(t) && typeof t.id === 'string') byId.set(t.id, mapActivity(t));
  }
  const seen = new Set(ids);
  const extra = (Array.isArray(d.rows) ? d.rows : []).map(mapRow).filter((r) => r.id && !seen.has(r.id));
  const rows = [...sync.rows, ...extra].map((r) => withActivity(r, byId.get(r.id) ?? EMPTY_ACTIVITY));
  return { ...sync, rows };
}

/** The thread's first page, or null when it can't be read (the detail then goes out without it). */
export async function readThread(requestId: string, staff: string): Promise<ThreadPage | null> {
  try {
    return mapThread(await rpc<unknown>('lp_messages_thread', { p_request: requestId, p_staff: staff }));
  } catch (error) {
    logSoft((error as { dbCode?: string } | null)?.dbCode ?? 'thread_failed');
    return null;
  }
}

/** lp_enroute_stats(), or {} when it can't be read (the dashboard shows "—"). */
export async function readEnrouteStats(): Promise<{ friendsEnRoute?: number; avgArriveMinutes?: number | null }> {
  try {
    const raw = await rpc<unknown>('lp_enroute_stats', {});
    if (!isObject(raw)) return {};
    const friends = typeof raw.friendsEnRoute === 'number' ? raw.friendsEnRoute : undefined;
    const avg = raw.avgArriveMinutes === null ? null : typeof raw.avgArriveMinutes === 'number' ? raw.avgArriveMinutes : Number.isFinite(Number(raw.avgArriveMinutes)) ? Number(raw.avgArriveMinutes) : undefined;
    return { ...(friends === undefined ? {} : { friendsEnRoute: friends }), ...(avg === undefined ? {} : { avgArriveMinutes: avg }) };
  } catch (error) {
    logSoft((error as { dbCode?: string } | null)?.dbCode ?? 'enroute_stats_failed');
    return {};
  }
}

// ---------------------------------------------------------------------------------------------------
// Notifications (contract D: F3 sends message, enroute, enroute_changed, enroute_cancelled, arrived)
// ---------------------------------------------------------------------------------------------------

/** Tells the request's involved staff (the actor is dropped by notifyStaff). Never throws. */
export async function notifyInvolved(recipients: readonly string[], event: ActivityEvent): Promise<void> {
  if (recipients.length === 0) return;
  try {
    await notifyStaff(recipients, event);
  } catch {
    logSoft('notify_failed');
  }
}

/** The notification for a message just posted (detail "Rae C.: Bring 1 person only"). */
export function messageEvent(requestId: string, actor: string, body: string): ActivityEvent {
  return { requestId, kind: 'message', actor, detail: messageDetail(actor, body) };
}

/** The notification for an en route change, by lp_set_enroute's event; null for none. */
export function enrouteEvent(
  requestId: string,
  actor: string,
  event: unknown,
  enroute: EnrouteSummary | null,
  now: number = Date.now(),
): ActivityEvent | null {
  const mineEta = enroute?.mine?.etaAt ?? null;
  const kinds: Record<string, { kind: ActivityKind; detail: string }> = {
    enroute: { kind: 'enroute', detail: enrouteDetail(mineEta, now) },
    changed: { kind: 'enroute_changed', detail: enrouteDetail(mineEta, now) },
    cancelled: { kind: 'enroute_cancelled', detail: DETAIL.enrouteCancelled },
    arrived: { kind: 'arrived', detail: DETAIL.arrived },
  };
  const hit = typeof event === 'string' ? kinds[event] : undefined;
  return hit ? { requestId, actor, ...hit } : null;
}
