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
export const UNDO_MS = 6_000;
export const STATS_POLL_MS = 15_000;
export const OUTBOX_BACKOFF_MS = [5_000, 15_000, 60_000, 120_000] as const;
export const DRAFT_DEBOUNCE_MS = 300;

/** localStorage key of Jeffrey's legacy offline queue (imported into the outbox once, then removed). */
export const LEGACY_QUEUE_KEY = 'edc_pending_queue';

