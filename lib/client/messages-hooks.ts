'use client';
// Hooks for messages and en route (F3). Screens read threads, queued jobs and the effective en route row
// through these; they never call fetch. Every hook works without the engine (the test stub): no messages.
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { EnrouteSummary, RequestSummary } from '../api-types';
import type { MessagingApi, MessagingSnapshot, ThreadState } from './messages-core';
import { effectiveEnroute, failedEnrouteTap, type MessageJob } from './messages-logic';
import { useAppStore } from './store-contract';

const EMPTY: MessagingSnapshot = { threads: new Map(), jobs: [] };
const NO_JOBS: readonly MessageJob[] = [];
const noop = () => () => undefined;

export function useMessaging(): MessagingApi | null {
  return useAppStore().actions.messages ?? null;
}

/** A slice of the engine's snapshot; the server (and a store without the engine) renders EMPTY. */
function useMessagingSlice<T>(select: (s: MessagingSnapshot) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const api = useMessaging();
  const memo = useRef<{ snap: MessagingSnapshot; value: T } | null>(null);
  const get = useCallback(() => {
    const snap = api ? api.getSnapshot() : EMPTY;
    if (memo.current && memo.current.snap === snap) return memo.current.value;
    const value = select(snap);
    const kept = memo.current && isEqual(memo.current.value, value) ? memo.current.value : value;
    memo.current = { snap, value: kept };
    return kept;
  }, [api, select, isEqual]);
  const getServer = useCallback(() => select(EMPTY), [select]);
  return useSyncExternalStore(api ? api.subscribe : noop, get, getServer);
}

const sameJobs = (a: readonly MessageJob[], b: readonly MessageJob[]) => a.length === b.length && a.every((j, i) => j === b[i]);

/** The thread of a request as loaded (null before it has been opened). */
export function useThread(requestId: string): ThreadState | null {
  const select = useCallback((s: MessagingSnapshot) => s.threads.get(requestId) ?? null, [requestId]);
  return useMessagingSlice(select);
}

/** This phone's queued messages and en route taps for a request, oldest first. */
export function useRequestJobs(requestId: string): readonly MessageJob[] {
  const select = useCallback((s: MessagingSnapshot) => {
    const jobs = s.jobs.filter((j) => j.requestId === requestId);
    return jobs.length ? jobs : NO_JOBS;
  }, [requestId]);
  return useMessagingSlice(select, sameJobs);
}

/** Every queued job (Activity counts, sign-out). */
export function useAllJobs(): readonly MessageJob[] {
  return useMessagingSlice(selectAllJobs, sameJobs);
}
const selectAllJobs = (s: MessagingSnapshot) => s.jobs;

/** Keeps a request's thread open (loaded, refreshed, marked read) while the calling component is mounted. */
export function useOpenThread(requestId: string, active = true): void {
  const api = useMessaging();
  useEffect(() => {
    if (!api || !active) return;
    return api.open(requestId);
  }, [api, requestId, active]);
}

/** The en route row to show: the synced summary with my queued tap on top (optimistic, offline too). */
export function useEnroute(row: Pick<RequestSummary, 'id' | 'enroute'>): EnrouteSummary | null {
  const jobs = useRequestJobs(row.id);
  const enrouteJobs = useMemo(() => jobs.filter((j) => j.kind === 'enroute'), [jobs]);
  return useMemo(() => effectiveEnroute(row.enroute ?? null, enrouteJobs, 0), [row.enroute, enrouteJobs]);
}

/** My en route tap on this request that was not delivered ("Not delivered · Retry"), or null. */
export function useFailedEnroute(requestId: string): MessageJob | null {
  const jobs = useRequestJobs(requestId);
  return useMemo(() => failedEnrouteTap(jobs), [jobs]);
}

// ---------------------------------------------------------------------------------------------------
// "Open the thread": a Message button navigates to the request and asks its Messages to come into view
// with the composer focused. One flag, read once by the request's MessagesSection.
// ---------------------------------------------------------------------------------------------------

let focusRequest: { id: string; at: number } | null = null;

export function requestThreadFocus(requestId: string): void {
  focusRequest = { id: requestId, at: Date.now() };
}

/** True once for the request whose Message button was just tapped (within 5 s). */
export function takeThreadFocus(requestId: string): boolean {
  const f = focusRequest;
  if (!f || f.id !== requestId || Date.now() - f.at > 5_000) return false;
  focusRequest = null;
  return true;
}
