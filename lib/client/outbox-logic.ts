// Pure rules of the outbox (spec §7 Outbox, v2.1 A6/A13) and the sync backoff. No I/O.
import type { OutboxItem, RequestSummary } from '../api-types';
import { canonStaff, sameStaff } from '../domain';
import { OUTBOX_BACKOFF_MS, SYNC } from './constants';
import type { HttpFailure } from './http';
import type { OutboxPrompt } from './store-contract';

/** Create rejections that mean "this payload is wrong" → Needs attention (same mutationId on resend). */
export const CREATE_DEFINITIVE: ReadonlySet<number> = new Set([400, 403, 413, 415, 422]);
/** Photo rejections that will never succeed (photo limit, bad image, request gone) → the job finishes. */
export const PHOTO_DEFINITIVE: ReadonlySet<number> = new Set([400, 403, 404, 413, 415, 422]);

/** 5 s, 15 s, 60 s, then every 2 min (attempts counts failures so far, ≥ 1). */
export function outboxBackoffMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1) - 1, OUTBOX_BACKOFF_MS.length - 1);
  return OUTBOX_BACKOFF_MS[i] ?? 120_000;
}

/** Sync backoff after consecutive failures: 6 s, then 12 s (SYNC.backoffMs; hidden pages: nextPollDelay keeps 60 s). */
export function syncBackoffMs(failures: number): number {
  const steps = SYNC.backoffMs;
  return steps[Math.min(Math.max(failures, 1) - 1, steps.length - 1)] ?? 60_000;
}

/** Next poll delay: 6 s ± 1 s while visible, 60 s hidden, backoff after failures (never shorter when hidden). */
export function nextPollDelay(failures: number, visible: boolean, random: number): number {
  const base = failures > 0 ? syncBackoffMs(failures) : SYNC.visibleIntervalMs + Math.round((random * 2 - 1) * SYNC.jitterMs);
  return visible ? base : Math.max(base, SYNC.hiddenIntervalMs);
}

/** A6: the confirmed row this job already created (matched on clientMutationId), if any. */
export function confirmedRowForJob(job: Pick<OutboxItem, 'mutationId'>, confirmed: ReadonlyMap<string, RequestSummary>): RequestSummary | null {
  for (const row of confirmed.values()) if (row.clientMutationId === job.mutationId) return row;
  return null;
}

/** Jobs that wait for the operator prompt: not yet created, saved by someone other than the signed-in staff. */
export function jobsNeedingPrompt(jobs: readonly OutboxItem[], sessionStaff: string | null, approved: ReadonlySet<string>): OutboxItem[] {
  if (!sessionStaff) return [];
  return jobs.filter(
    (j) =>
      j.state !== 'needs_attention' &&
      !j.serverId &&
      !!j.operator.staff &&
      !approved.has(j.mutationId) &&
      !sameStaff(j.operator.staff, sessionStaff),
  );
}

/** "Send 2 requests saved by Dana Kim?" — one saver at a time (the oldest job's). */
export function promptFor(
  jobs: readonly OutboxItem[],
  sessionStaff: string | null,
  sessionName: string | null,
  approved: ReadonlySet<string>,
): { prompt: OutboxPrompt; ids: string[] } | null {
  const waiting = jobsNeedingPrompt(jobs, sessionStaff, approved);
  const first = waiting[0];
  if (!first) return null;
  const saver = canonStaff(first.operator.staff);
  const group = waiting.filter((j) => canonStaff(j.operator.staff) === saver);
  return {
    prompt: { count: group.length, savedBy: first.operator.staffName || first.operator.staff, sendAs: sessionName ?? '' },
    ids: group.map((j) => j.mutationId),
  };
}

/** The copy for a failed mutation (never request data). */
export function failureCode(res: HttpFailure): 'network' | 'timeout' | NonNullable<Extract<HttpFailure, { kind: 'http' }>['error']>['code'] {
  if (res.kind === 'network') return 'network';
  if (res.kind === 'timeout') return 'timeout';
  return res.error?.code ?? (res.status >= 500 ? 'unavailable' : 'bad_request');
}
