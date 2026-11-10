// Pure rules of messages and en route on the client (F3, spec §18 A55–A57). No I/O, no React.
//   * the message / en route outbox: what is due, how a failure is classified, which jobs may go out
//   * the thread: merging pages, bubbles grouped like iMessage, the receipt under my latest message
//   * the optimistic en route row while a tap is queued
// Carrying a row's activity and the in-app message alert are in ./messages-activity (first-load code),
// re-exported here.
import type { EnrouteSummary, RequestSummary, ThreadMessage, ThreadReceipt } from '../api-types';
import { canonStaff, sameStaff } from '../domain';
import { unreadOf } from '../messaging';
import type { HttpFailure } from './http';

export { activityOf, carryActivity, diffMessageAlerts, messageAlertKey, type MessageAlert } from './messages-activity';

// ---------------------------------------------------------------------------------------------------
// Jobs (the durable outbox of messages and en route taps, IndexedDB `mjob:<id>`)
// ---------------------------------------------------------------------------------------------------

export type EnrouteAction = 'set' | 'cancel' | 'arrive';

export interface MessageJob {
  /** = the clientMutationId the server dedupes on. */
  id: string;
  kind: 'message' | 'enroute';
  requestId: string;
  /** kind 'message': the text (trimmed, ≤ 500). */
  body?: string;
  /** kind 'enroute': the tap. etaAt is set only by the Undo of a cancel (the exact ETA back). */
  enroute?: { action: EnrouteAction; etaMinutes: number | null; etaAt?: string | null };
  /** Attribution of who queued it: it only goes out under the same staff (never as someone else). */
  operator: string;
  /** Epoch ms on this phone (order, the queued ETA offset, display). */
  createdAt: number;
  /** 'sending' is in memory only; 'failed' shows "Not delivered · Retry" and is not retried by itself. */
  state: 'pending' | 'sending' | 'failed';
  attempts: number;
  nextAttemptAt: number | null;
  error: { code: string; message: string } | null;
  /** (Events) The event it was queued in: it is only ever sent to that event (absent: before events, 'none'). */
  eventId?: string;
}

/** Network / timeout / 5xx failures while online before a message shows "Not delivered · Retry". */
export const MAX_SILENT_ATTEMPTS = 3;
/** Retry waits for pending jobs: 3 s, 10 s, 30 s, then every minute. */
export const JOB_BACKOFF_MS = [3_000, 10_000, 30_000, 60_000] as const;

export function jobBackoffMs(attempts: number): number {
  return JOB_BACKOFF_MS[Math.min(Math.max(attempts, 1) - 1, JOB_BACKOFF_MS.length - 1)] ?? 60_000;
}

/** Rejections that will never succeed as they are (the bubble shows "Not delivered · Retry"). 410: the event ended. */
export const JOB_DEFINITIVE: ReadonlySet<number> = new Set([400, 403, 404, 410, 413, 422]);

export type JobOutcome =
  | { type: 'done' }
  | { type: 'unauthorized' }
  | { type: 'rate_limited'; retryAfterMs: number }
  | { type: 'rejected'; code: string; message: string }
  | { type: 'retry' };

/** How the outbox treats an answer. */
export function classifyJobFailure(res: HttpFailure): JobOutcome {
  if (res.kind !== 'http') return { type: 'retry' };
  if (res.status === 401) return { type: 'unauthorized' };
  if (res.status === 429) {
    const seconds = res.error?.retryAfterSeconds;
    return { type: 'rate_limited', retryAfterMs: Math.max(1, Math.min(60, typeof seconds === 'number' ? seconds : 20)) * 1000 };
  }
  if (res.error !== null && JOB_DEFINITIVE.has(res.status)) {
    return { type: 'rejected', code: res.error.code, message: res.error.message };
  }
  return { type: 'retry' };
}

/** Jobs in the order they go out (oldest first; ties by id). */
export function jobOrder(jobs: readonly MessageJob[]): MessageJob[] {
  return [...jobs].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** May this job go out now, for the staff signed in? (Never as someone else; failed ones wait for Retry.) */
export function jobSendable(job: MessageJob, sessionStaff: string | null, now: number): boolean {
  if (job.state !== 'pending') return false;
  if (job.nextAttemptAt !== null && job.nextAttemptAt > now) return false;
  return !job.operator || sameStaff(job.operator, sessionStaff);
}

/** A stored job read back (IndexedDB): 'sending' becomes pending again; anything malformed is dropped. */
export function storedJob(value: unknown): MessageJob | null {
  const j = value as MessageJob | null;
  if (!j || typeof j !== 'object' || typeof j.id !== 'string' || typeof j.requestId !== 'string') return null;
  if (j.kind !== 'message' && j.kind !== 'enroute') return null;
  if (j.kind === 'message' && typeof j.body !== 'string') return null;
  if (j.kind === 'enroute' && (!j.enroute || !['set', 'cancel', 'arrive'].includes(j.enroute.action))) return null;
  return {
    ...j,
    operator: typeof j.operator === 'string' ? j.operator : '',
    createdAt: typeof j.createdAt === 'number' ? j.createdAt : 0,
    state: j.state === 'failed' ? 'failed' : 'pending',
    attempts: typeof j.attempts === 'number' ? j.attempts : 0,
    nextAttemptAt: typeof j.nextAttemptAt === 'number' ? j.nextAttemptAt : null,
    error: j.error && typeof j.error.message === 'string' ? j.error : null,
  };
}

// ---------------------------------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------------------------------

const byTime = (a: ThreadMessage, b: ThreadMessage) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * The thread after a fresh first (latest) page: everything the page covers comes from it (a message unsent
 * since simply isn't there any more); older messages loaded with "Earlier messages" stay, unless the page
 * reaches back to the start (hasEarlier false), which makes it complete.
 */
export function mergeLatestPage(current: readonly ThreadMessage[], page: readonly ThreadMessage[], pageHasEarlier: boolean): ThreadMessage[] {
  const latest = [...page].sort(byTime);
  if (!pageHasEarlier) return latest;
  const oldest = latest[0];
  if (!oldest) return latest;
  const ids = new Set(latest.map((m) => m.id));
  const older = current.filter((m) => !ids.has(m.id) && byTime(m, oldest) < 0);
  return [...older, ...latest].sort(byTime);
}

/** An earlier page in front of what is loaded (deduplicated). */
export function mergeEarlierPage(current: readonly ThreadMessage[], page: readonly ThreadMessage[]): ThreadMessage[] {
  const ids = new Set(current.map((m) => m.id));
  return [...page.filter((m) => !ids.has(m.id)), ...current].sort(byTime);
}

/** A message the server confirmed for a queued bubble, added in place (no refetch needed). */
export function addConfirmed(current: readonly ThreadMessage[], message: ThreadMessage): ThreadMessage[] {
  if (current.some((m) => m.id === message.id)) return [...current];
  return [...current, message].sort(byTime);
}

/** The newest message on screen: the read cursor moves up to it. */
export function newestAt(messages: readonly ThreadMessage[]): string | null {
  return messages.length ? (messages[messages.length - 1]?.createdAt ?? null) : null;
}

/**
 * What one bubble shows. `run`: first of a run of the same sender (gets the "Name · Team · 12:14 PM" line, or the time
 * alone over my own run).
 */
export interface Bubble {
  key: string;
  /** Server message, or a queued one from this phone (jobId). */
  message: ThreadMessage | null;
  jobId: string | null;
  body: string;
  mine: boolean;
  by: string;
  team: string;
  /** First bubble of this sender's run (others' runs get the name line, mine the time; a gap goes above every run). */
  runStart: boolean;
  /** Last bubble of the run (the tail corner). */
  runEnd: boolean;
  /** Queued: "Sending…" / failed: "Not delivered · Retry". */
  pending: 'sending' | 'failed' | null;
  createdAt: string;
}

/**
 * (2026-11-08, T5) A run also breaks when more than this passed since the bubble before it, so the time on a run's
 * label is never far from any bubble under it ("Dana K. · 12:14 PM" over a message sent at 12:32 would mislead).
 */
export const RUN_BREAK_MS = 5 * 60_000;

/** More than RUN_BREAK_MS from `a` to `b` (an unreadable time, or a queued bubble timed before the last, never breaks). */
function farApart(a: { createdAt: string }, b: { createdAt: string }): boolean {
  const gap = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return Number.isFinite(gap) && gap > RUN_BREAK_MS;
}

/**
 * Bubbles in order: the server's messages, then this phone's queued ones (not yet confirmed). A queued
 * message the server already has (same clientMutationId) shows once, as the server's. A run is one sender's
 * bubbles in a row, none more than 5 minutes after the one before it (display only: nothing else reads runs).
 */
export function buildBubbles(messages: readonly ThreadMessage[], queued: readonly MessageJob[], me: { by: string; team: string }): Bubble[] {
  const confirmedIds = new Set(messages.map((m) => m.clientMutationId));
  const items: Array<Omit<Bubble, 'runStart' | 'runEnd'>> = messages.map((m) => ({
    key: m.id,
    message: m,
    jobId: null,
    body: m.body,
    mine: m.mine,
    by: m.by,
    team: m.team,
    pending: null,
    createdAt: m.createdAt,
  }));
  for (const job of jobOrder(queued)) {
    if (job.kind !== 'message' || confirmedIds.has(job.id) || typeof job.body !== 'string') continue;
    items.push({
      key: `job:${job.id}`,
      message: null,
      jobId: job.id,
      body: job.body,
      mine: true,
      by: me.by,
      team: me.team,
      pending: job.state === 'failed' ? 'failed' : 'sending',
      createdAt: new Date(job.createdAt).toISOString(),
    });
  }
  const sender = (b: Omit<Bubble, 'runStart' | 'runEnd'>) => (b.mine ? '\u0000me' : `${b.by}\u0000${b.team}`);
  const sameRun = (a: Omit<Bubble, 'runStart' | 'runEnd'>, b: Omit<Bubble, 'runStart' | 'runEnd'>) => sender(a) === sender(b) && !farApart(a, b);
  return items.map((b, i) => {
    const prev = items[i - 1];
    const next = items[i + 1];
    return { ...b, runStart: !prev || !sameRun(prev, b), runEnd: !next || !sameRun(b, next) };
  });
}

/**
 * The receipt under MY latest confirmed message: "Read 4:14 PM" once someone else read past it, else
 * "Delivered". Null when I have not written (or my latest is still queued: it shows "Sending…").
 */
export function receiptFor(messages: readonly ThreadMessage[], receipt: ThreadReceipt | null): { messageId: string; readAt: string | null } | null {
  let mine: ThreadMessage | null = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.mine) {
      mine = m;
      break;
    }
  }
  if (!mine) return null;
  return { messageId: mine.id, readAt: receipt && receipt.messageId === mine.id ? receipt.readAt : null };
}

// ---------------------------------------------------------------------------------------------------
// Optimistic en route (a tap queued or on its way)
// ---------------------------------------------------------------------------------------------------

/**
 * The en route summary to show: the server's, with my latest queued tap applied on top. Others' rows are
 * the server's; my own is replaced (set), removed (cancel) or marked arrived (arrive). A tap that was not
 * delivered still counts (what I asked for stays on screen, with "Not delivered · Retry" under it) until it is
 * retried, deleted or replaced by a new tap.
 */
export function effectiveEnroute(server: EnrouteSummary | null | undefined, myJobs: readonly MessageJob[], now: number): EnrouteSummary | null {
  const base = server ?? null;
  const taps = jobOrder(myJobs).filter((j) => j.kind === 'enroute' && j.enroute);
  const last = taps[taps.length - 1];
  if (!last?.enroute) return base;
  const hadMine = !!base?.mine && (base.mine.state ?? 'enroute') === 'enroute';
  const others = Math.max(0, (base?.count ?? 0) - (hadMine ? 1 : 0));
  const othersEta = others > 0 ? (base?.earliestEta ?? null) : null;
  const arrivedByOthers = base?.state === 'arrived' && !(base?.mine?.state === 'arrived');
  switch (last.enroute.action) {
    case 'set': {
      const etaAt =
        last.enroute.etaAt !== undefined && last.enroute.etaAt !== null
          ? last.enroute.etaAt
          : last.enroute.etaMinutes === null
            ? null
            : new Date(last.createdAt + last.enroute.etaMinutes * 60_000).toISOString();
      const earliest = [othersEta, etaAt].filter((x): x is string => !!x).sort()[0] ?? null;
      return {
        count: others + 1,
        earliestEta: earliest,
        state: arrivedByOthers ? 'arrived' : 'enroute',
        mine: { etaAt, etaMinutes: last.enroute.etaMinutes, state: 'enroute' },
      };
    }
    case 'cancel': {
      if (others === 0 && !arrivedByOthers) return null;
      return { count: others, earliestEta: othersEta, state: arrivedByOthers ? 'arrived' : 'enroute', mine: null };
    }
    case 'arrive':
      void now;
      return {
        count: others,
        earliestEta: othersEta,
        state: 'arrived',
        mine: { etaAt: base?.mine?.etaAt ?? null, etaMinutes: base?.mine?.etaMinutes ?? null, state: 'arrived' },
      };
  }
}

/** My latest en route tap on a request that was not delivered (it shows "Not delivered · Retry"), or null. */
export function failedEnrouteTap(myJobs: readonly MessageJob[]): MessageJob | null {
  const failed = jobOrder(myJobs).filter((j) => j.kind === 'enroute' && j.enroute && j.state === 'failed');
  return failed[failed.length - 1] ?? null;
}

// ---------------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------------

/** Unread messages over every request (the Pending tab and nav dots count requests with unread > 0). */
export function unreadRequests(rows: readonly RequestSummary[]): number {
  let n = 0;
  for (const r of rows) if (unreadOf(r) > 0) n += 1;
  return n;
}

/** Canonical staff of a job's operator (for prompts and filters). */
export const operatorKey = (job: MessageJob) => canonStaff(job.operator) ?? '';
