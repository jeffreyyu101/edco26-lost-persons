// Client timing constants (spec §7). Re-exported by store-contract.ts.
export const SYNC = {
  visibleIntervalMs: 6_000,
  jitterMs: 1_000,
  hiddenIntervalMs: 60_000,
  requestTimeoutMs: 12_000,
  backoffMs: [6_000, 12_000, 24_000, 60_000],
  reconcileEvery: 10,
  fullFetchAfterMs: 6 * 60 * 60 * 1000,
  pageLimit: 500,
} as const;

export const MUTATION_TIMEOUT_MS = 10_000;
/** How long the Undo bar stays after an answer tap (10 s since v2.2, Brian + Jeffrey 2026-11-06; was 6 s). */
export const UNDO_MS = 10_000;
export const STATS_POLL_MS = 15_000;
/**
 * Failures in a row before a connection reads as down: network errors or timeouts (the store: 'offline'), and
 * HTTP 5xx (the store: 'error'). The dashboard's stats poller counts its own failures the same way.
 */
export const CONNECTION_FAILURES = { network: 2, http: 3 } as const;
export const OUTBOX_BACKOFF_MS = [5_000, 15_000, 60_000, 120_000] as const;
export const DRAFT_DEBOUNCE_MS = 300;

/** localStorage key of Jeffrey's legacy offline queue (imported into the outbox once, then removed). */
export const LEGACY_QUEUE_KEY = 'edc_pending_queue';

