// The messages and en route engine of the client store (F3, spec §18 A55–A57). Built by createAppStore
// (lib/client/store-core.ts), which hands it a host: the store's own API door (call), session, rows and
// IndexedDB queue. Pure construction like the store (server-render invariants): nothing starts before
// start(). Screens reach it through actions.messages and the hooks in lib/client/messages-hooks.ts.
//
//   Outbox   Every message and en route tap is a job, saved in IndexedDB (`mjob:<id>`, a key older builds
//            never read) before it is sent, sent in order, exactly once (the server dedupes on the job id;
//            en route repeats change nothing). Offline it waits ("Sending…"); a definitive rejection or 3
//            failed tries while online show "Not delivered · Retry". A job only goes out under the staff
//            who queued it. Nothing is ever dropped silently.
//   Threads  Loaded when a request's Messages is on screen, refreshed every 6 s while it is (for receipts)
//            and whenever the synced row says the thread changed. The latest page is cached per staff
//            (`cache:<event>:<staff>:thread:<id>`, cleared with the rest of the cache at sign-out).
//   Read     A thread on screen marks itself read up to the newest message it shows.
//
// Privacy: nothing here logs.
import type { ActivityResponse, PostMessageResponse, RequestActivityDto, RequestSummary, ThreadMessage, ThreadPage } from '../api-types';
import { canonStaff, parseStaff, sameStaff } from '../domain';
import { MESSAGE_MAX, THREAD_PAGE, UNSEND_WINDOW_MS, cleanMessage, messageLength, senderShort } from '../messaging';
import { SYNC } from './constants';
import type { HttpResult, RequestOptions } from './http';
import {
  MAX_SILENT_ATTEMPTS,
  addConfirmed,
  classifyJobFailure,
  jobBackoffMs,
  jobOrder,
  jobSendable,
  mergeEarlierPage,
  mergeLatestPage,
  newestAt,
  storedJob,
  type EnrouteAction,
  type MessageJob,
} from './messages-logic';
import type { Kv } from './persist';
import type { ToastItem } from './store-contract';
import { uuid } from './uuid';

export const MESSAGE_TIMEOUT_MS = 10_000;
/** "En route cancelled · Undo" stays this long. */
export const ENROUTE_UNDO_MS = 5_000;
const ENROUTE_CANCELLED = 'En route cancelled';
/** A thread on screen refreshes this often (receipts, messages from people this phone has not synced yet). */
export const THREAD_POLL_MS = 6_000;
/** A thread fetched less than this long ago is not fetched again on open. */
const THREAD_FRESH_MS = 3_000;
const JOB_KEY = (id: string) => `mjob:${id}`;
/** `cacheKey`: the store's "<event id>:<canonical staff>" (MessagingHost.cacheStaff). */
const THREAD_KEY = (cacheKey: string, id: string) => `cache:${cacheKey}:thread:${id}`;

export interface ThreadState {
  status: 'loading' | 'ready' | 'error';
  messages: readonly ThreadMessage[];
  hasEarlier: boolean;
  loadingEarlier: boolean;
  receipt: ThreadPage['receipt'];
  /** Epoch ms of the last successful load of the latest page (0 = never; a cached copy may show). */
  loadedAt: number;
}

export interface MessagingSnapshot {
  threads: ReadonlyMap<string, ThreadState>;
  jobs: readonly MessageJob[];
}

/** What the store gives the engine. */
export interface MessagingHost {
  call<T>(path: string, opts: RequestOptions): Promise<HttpResult<T>>;
  online(): boolean;
  visible(): boolean;
  /** The store is running, signed in (confirmed), online, and no sign-out is pending. */
  canSend(): boolean;
  /** Confirms the session when it is due (resume, another tab signed in); true when sending may go on. */
  ensureSession(): Promise<boolean>;
  sessionExpired(): void;
  /** Attribution "Name · Team" of the signed-in staff (null before it is known). */
  staff(): string | null;
  /** "<event id>:<canonical staff>" whose cache is loaded (the thread cache key), or null. */
  cacheStaff(): string | null;
  /** (Events) The event this tab works ('none' before one is known): jobs are queued in it and only sent to it. */
  eventId(): string;
  generation(): number;
  kv(): Kv | null;
  enqueue<T>(op: (store: Kv) => Promise<T>): Promise<T | undefined>;
  durable(): boolean;
  row(id: string): RequestSummary | undefined;
  /** Writes the request's activity into the confirmed row (same rowVersion; never alerts). */
  patchActivity(id: string, activity: Partial<RequestActivityDto>): void;
  markLive(): void;
  showToast(toast: Omit<ToastItem, 'id'>): string;
  /** The bottom Undo bar with a custom action (en route cancelled · Undo). */
  showUndo(message: string, ms: number, onUndo: () => void): void;
  /** Tells the other tabs the jobs changed. */
  broadcast(): void;
  locks(): { request<T>(name: string, options: { ifAvailable?: boolean }, cb: (lock: unknown) => Promise<T>): Promise<T> } | null;
}

export interface MessagingApi {
  getSnapshot(): MessagingSnapshot;
  subscribe(listener: () => void): () => void;
  /** A request's Messages is on screen: load it, keep it fresh, alert nothing for it. Returns the close. */
  open(requestId: string): () => void;
  isOpen(requestId: string): boolean;
  refresh(requestId: string): void;
  loadEarlier(requestId: string): Promise<void>;
  /** Queue a message. False when the text is empty or too long (nothing queued). */
  send(requestId: string, body: string): Promise<boolean>;
  retry(jobId: string): void;
  discard(jobId: string): Promise<void>;
  /** Within 15 minutes, my own message only. Needs a connection. */
  unsend(requestId: string, messageId: string): Promise<boolean>;
  /** En route / Change ETA / Cancel en route / Arrived. Queued like a message. */
  setEnroute(requestId: string, action: EnrouteAction, etaMinutes: number | null, opts?: { etaAt?: string | null }): Promise<void>;
  /** Cancel my en route, with "En route cancelled · Undo" for 5 s (Undo puts the same ETA back). */
  cancelEnroute(requestId: string, previous: { etaAt: string | null; etaMinutes: number | null }): Promise<void>;
  /** Marks the thread read up to the newest message shown (the thread view calls it while visible). */
  markRead(requestId: string): void;
  /** Unsent jobs on this phone (sign-out asks before discarding them). */
  unsentCount(): number;
}

export interface MessagingEngine extends MessagingApi {
  start(): void;
  stop(): void;
  /** Read the jobs saved on this phone (after the store opened IndexedDB). */
  hydrate(): Promise<void>;
  /** Another tab changed the jobs. */
  reload(): Promise<void>;
  /** Something may now allow sending (signed in, online, a sync succeeded). */
  kick(): void;
  /** Sign-out or another staff: threads go; jobs too when `discardJobs` (their IndexedDB keys with them). */
  clear(discardJobs: boolean): Promise<void>;
}

const EMPTY_THREAD: ThreadState = { status: 'loading', messages: [], hasEarlier: false, loadingEarlier: false, receipt: null, loadedAt: 0 };

export function createMessaging(host: MessagingHost): MessagingEngine {
  let snapshot: MessagingSnapshot = { threads: new Map(), jobs: [] };
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of [...listeners]) l();
  };
  const setThreads = (threads: Map<string, ThreadState>) => {
    snapshot = { ...snapshot, threads };
    emit();
  };
  const setJobs = (jobs: readonly MessageJob[]) => {
    snapshot = { ...snapshot, jobs };
    emit();
  };
  const patchThread = (id: string, patch: Partial<ThreadState>) => {
    const threads = new Map(snapshot.threads);
    threads.set(id, { ...(threads.get(id) ?? EMPTY_THREAD), ...patch });
    setThreads(threads);
  };

  let running = false;
  const openCounts = new Map<string, number>();
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const loading = new Map<string, Promise<void>>();
  let working = false;
  let again = false;
  let workTimer: ReturnType<typeof setTimeout> | undefined;
  /** upto last sent per request, so an open thread with nothing new posts nothing. */
  const readSent = new Map<string, string>();
  let rateToastAt = 0;

  const now = () => Date.now();
  const getJob = (id: string) => snapshot.jobs.find((j) => j.id === id) ?? null;
  const patchJob = (id: string, patch: Partial<MessageJob>): MessageJob | null => {
    let updated: MessageJob | null = null;
    const jobs = snapshot.jobs.map((j) => {
      if (j.id !== id) return j;
      updated = { ...j, ...patch };
      return updated;
    });
    if (updated) setJobs(jobs);
    return updated;
  };

  // ---- persistence ----
  const persistJob = async (job: MessageJob): Promise<boolean> => {
    if (!host.kv() || !host.durable()) return false;
    const gen = host.generation();
    const stored: MessageJob = { ...job, state: job.state === 'sending' ? 'pending' : job.state };
    const ok = await host.enqueue(async (store) => {
      if (gen !== host.generation()) return false;
      await store.set(JOB_KEY(job.id), stored);
      return true;
    });
    return ok === true;
  };
  const deleteJob = async (id: string) => {
    await host.enqueue((store) => store.del(JOB_KEY(id)));
  };
  /** Read through the store's write queue, so a job state written just before is what comes back. */
  const readJobs = async (): Promise<MessageJob[]> => {
    const values = await host.enqueue(async (store) => {
      const keys = (await store.keys()).filter((k) => k.startsWith('mjob:'));
      return keys.length === 0 ? [] : store.getMany<unknown>(keys);
    });
    // (Events) Only this event's: another event's queued messages are never shown or sent here.
    const event = host.eventId();
    return (values ?? []).map(storedJob).filter((j): j is MessageJob => j !== null && (j.eventId ?? 'none') === event);
  };

  const writeThreadCache = (id: string, t: ThreadState) => {
    const staffKey = host.cacheStaff();
    if (!staffKey || !host.kv()) return;
    const gen = host.generation();
    const value = { messages: t.messages.slice(-THREAD_PAGE), hasEarlier: t.hasEarlier || t.messages.length > THREAD_PAGE, receipt: t.receipt };
    void host.enqueue(async (store) => {
      if (gen !== host.generation() || host.cacheStaff() !== staffKey) return;
      await store.set(THREAD_KEY(staffKey, id), value);
    });
  };
  const readThreadCache = async (id: string): Promise<Pick<ThreadState, 'messages' | 'hasEarlier' | 'receipt'> | null> => {
    const staffKey = host.cacheStaff();
    const kv = host.kv();
    if (!staffKey || !kv) return null;
    try {
      const v = await kv.get<{ messages?: unknown; hasEarlier?: unknown; receipt?: unknown }>(THREAD_KEY(staffKey, id));
      if (!v || !Array.isArray(v.messages)) return null;
      return { messages: v.messages as ThreadMessage[], hasEarlier: v.hasEarlier === true, receipt: (v.receipt as ThreadPage['receipt']) ?? null };
    } catch {
      return null;
    }
  };

  // ---- threads ----
  const threadPath = (id: string, before?: { at: string; id: string }) => {
    const base = `/api/requests/${encodeURIComponent(id)}/messages`;
    if (!before) return base;
    const q = new URLSearchParams({ beforeAt: before.at, beforeId: before.id });
    return `${base}?${q.toString()}`;
  };

  const loadLatest = (id: string): Promise<void> => {
    const inflight = loading.get(id);
    if (inflight) return inflight;
    const run = (async () => {
      const gen = host.generation();
      const current = snapshot.threads.get(id);
      if (!current) {
        patchThread(id, { ...EMPTY_THREAD });
        const cached = await readThreadCache(id);
        if (cached && gen === host.generation() && (snapshot.threads.get(id)?.loadedAt ?? 0) === 0) {
          patchThread(id, { ...cached, status: 'ready' });
        }
      }
      if (!host.online()) {
        const t = snapshot.threads.get(id);
        if (t && t.status === 'loading' && t.messages.length === 0) patchThread(id, { status: 'error' });
        return;
      }
      const sentFor = host.cacheStaff();
      const res = await host.call<ThreadPage>(threadPath(id), { timeoutMs: SYNC.requestTimeoutMs });
      if (gen !== host.generation()) return;
      if (res.ok && Array.isArray(res.data.messages)) {
        // (network fix 4 follow-up) The page answers for whoever the cookie belongs to (`mine`, receipt, unread). Sent at
        // once (a resume's thread poll, fix 4), it is applied only once the session check due then has confirmed the
        // same staff, as the resume sync is (fix 1a): another staff's view never shows, is cached, or gets marked read
        // here. ensureSession joins the store's check in flight, and answers at once when none is due.
        const confirmed = await host.ensureSession();
        if (gen !== host.generation() || (sentFor !== null && host.cacheStaff() !== sentFor)) return;
        if (!confirmed) {
          const t = snapshot.threads.get(id);
          if (t && t.messages.length === 0 && t.loadedAt === 0) patchThread(id, { status: 'error' });
          return;
        }
        const page = res.data;
        const before = snapshot.threads.get(id) ?? EMPTY_THREAD;
        const messages = mergeLatestPage(before.loadedAt > 0 ? before.messages : [], page.messages, page.hasEarlier);
        const next: ThreadState = {
          status: 'ready',
          messages,
          // Older messages loaded with "Earlier messages" keep their own state; a complete page has none.
          hasEarlier: !page.hasEarlier ? false : messages.length > page.messages.length ? before.hasEarlier : true,
          loadingEarlier: before.loadingEarlier,
          receipt: page.receipt,
          loadedAt: now(),
        };
        // The row's activity first: a screen that sees the thread loaded sees the unread count it came with.
        if (page.activity) host.patchActivity(id, page.activity);
        patchThread(id, next);
        host.markLive();
        writeThreadCache(id, next);
        return;
      }
      if (!res.ok && res.kind === 'http' && res.status === 401) host.sessionExpired();
      const t = snapshot.threads.get(id);
      if (t && t.messages.length === 0 && t.loadedAt === 0) patchThread(id, { status: 'error' });
    })().finally(() => loading.delete(id));
    loading.set(id, run);
    return run;
  };

  const pollOpen = () => {
    if (!running || !host.visible() || !host.online()) return;
    for (const id of openCounts.keys()) {
      const t = snapshot.threads.get(id);
      if (t && now() - t.loadedAt < THREAD_POLL_MS - 500) continue;
      void loadLatest(id);
    }
  };

  // (network fix 4, 2026-11-08) A phone unlocked on a request page: its thread poll was suspended with the page, and
  // an overdue tick can run before the page hears it is visible (then pollOpen skips it). Coming back into view
  // polls the open threads at once, alongside the resume sync, instead of waiting up to a tick (6 s) or for the
  // session check, the sync and the lastMessageAt refresh one after the other. pollOpen skips a thread loaded under
  // 5.5 s ago, a hidden page and an offline phone, so the next tick never fetches it twice.
  const doc = typeof document === 'undefined' ? null : document;

  const ensurePoll = () => {
    if (!running) return;
    if (openCounts.size > 0 && !pollTimer) pollTimer = setInterval(pollOpen, THREAD_POLL_MS);
    if (openCounts.size === 0 && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  // ---- the outbox worker ----
  const scheduleWork = () => {
    if (workTimer) clearTimeout(workTimer);
    workTimer = undefined;
    if (!running) return;
    const due = snapshot.jobs.filter((j) => j.state === 'pending' && j.nextAttemptAt !== null).map((j) => j.nextAttemptAt as number);
    if (due.length === 0) return;
    workTimer = setTimeout(() => {
      workTimer = undefined;
      kick();
    }, Math.max(300, Math.min(...due) - now()));
  };

  const kick = () => {
    if (!running) return;
    if (working) {
      again = true;
      return;
    }
    void work();
  };

  const work = async () => {
    working = true;
    try {
      do {
        again = false;
        if (!snapshot.jobs.some((j) => j.state === 'pending')) break;
        if (!(await host.ensureSession())) break;
        if (!host.canSend()) break;
        const locks = host.locks();
        if (locks) await locks.request('lp-msg-outbox', {}, async () => pass());
        else await pass();
      } while (again && running);
    } catch {
      // A broken pass is retried by the next trigger.
    } finally {
      working = false;
      scheduleWork();
    }
  };

  /** One pass in order. A job that can't go now stops the pass (later jobs keep their order). */
  const pass = async () => {
    const gen = host.generation();
    // Another tab may have sent some meanwhile.
    await reload();
    for (const queued of jobOrder(snapshot.jobs)) {
      if (!running || gen !== host.generation() || !host.canSend()) return;
      const job = getJob(queued.id);
      if (!job || !jobSendable(job, host.staff(), now())) {
        if (job && job.state === 'pending' && job.nextAttemptAt !== null && job.nextAttemptAt > now()) return;
        continue;
      }
      const result = await sendJob(job, gen);
      if (result === 'stop') return;
    }
  };

  const sendJob = async (job: MessageJob, gen: number): Promise<'next' | 'stop'> => {
    patchJob(job.id, { state: 'sending' });
    let res: HttpResult<PostMessageResponse | ActivityResponse>;
    if (job.kind === 'message') {
      res = await host.call<PostMessageResponse>(`/api/requests/${encodeURIComponent(job.requestId)}/messages`, {
        method: 'POST',
        json: { clientMutationId: job.id, body: job.body },
        timeoutMs: MESSAGE_TIMEOUT_MS,
      });
    } else {
      const e = job.enroute ?? { action: 'cancel' as const, etaMinutes: null };
      const json =
        e.action === 'set'
          ? e.etaAt !== undefined && e.etaAt !== null
            ? { action: 'set', etaAt: e.etaAt, etaMinutes: e.etaMinutes }
            : { action: 'set', etaMinutes: e.etaMinutes, queuedMs: Math.max(0, Math.min(6 * 3_600_000, now() - job.createdAt)) }
          : { action: e.action };
      res = await host.call<ActivityResponse>(`/api/requests/${encodeURIComponent(job.requestId)}/enroute`, {
        method: 'POST',
        json,
        timeoutMs: MESSAGE_TIMEOUT_MS,
      });
    }
    if (gen !== host.generation()) return 'stop';
    if (!getJob(job.id)) return 'next'; // discarded meanwhile
    if (res.ok) {
      host.markLive();
      if (job.kind === 'message') {
        const data = res.data as PostMessageResponse;
        if (data.message && typeof data.message.id === 'string') {
          const t = snapshot.threads.get(job.requestId);
          if (t) {
            const next = { ...t, messages: addConfirmed(t.messages, data.message), receipt: { messageId: data.message.id, readAt: null } };
            patchThread(job.requestId, next);
            writeThreadCache(job.requestId, next);
          }
        }
      }
      const activity = (res.data as { activity?: RequestActivityDto }).activity;
      if (activity) host.patchActivity(job.requestId, activity);
      await removeJob(job.id);
      // The read cursor is mine to keep: sending is reading what is above it.
      if (job.kind === 'message') readSent.delete(job.requestId);
      return 'next';
    }
    const outcome = classifyJobFailure(res);
    switch (outcome.type) {
      case 'unauthorized':
        patchJob(job.id, { state: 'pending' });
        host.sessionExpired();
        return 'stop';
      case 'rate_limited': {
        const next = patchJob(job.id, { state: 'pending', nextAttemptAt: now() + outcome.retryAfterMs });
        if (next) void persistJob(next);
        if (now() - rateToastAt > 20_000) {
          rateToastAt = now();
          host.showToast({ tone: 'amber', icon: 'info', title: 'Too many messages', subtitle: `Sends in ${Math.ceil(outcome.retryAfterMs / 1000)} s`, durationMs: 5_000 });
        }
        return 'stop';
      }
      case 'rejected': {
        const next = patchJob(job.id, { state: 'failed', nextAttemptAt: null, error: { code: outcome.code, message: outcome.message } });
        if (next) void persistJob(next);
        host.broadcast();
        return 'next';
      }
      default: {
        const attempts = job.attempts + 1;
        // Offline it simply waits ("Sending…"); online, 3 failed tries show "Not delivered · Retry".
        const failed = host.online() && attempts >= MAX_SILENT_ATTEMPTS;
        const next = patchJob(job.id, {
          state: failed ? 'failed' : 'pending',
          attempts: host.online() ? attempts : job.attempts,
          nextAttemptAt: failed ? null : now() + jobBackoffMs(Math.max(1, attempts)),
          error: failed ? { code: 'network', message: 'Not delivered' } : null,
        });
        if (next) void persistJob(next);
        return 'stop';
      }
    }
  };

  const removeJob = async (id: string) => {
    memoryOnly.delete(id);
    setJobs(snapshot.jobs.filter((j) => j.id !== id));
    await deleteJob(id);
    host.broadcast();
  };

  /** Jobs this tab could not save (IndexedDB failed): kept in memory, shown, and sent like the rest. */
  const memoryOnly = new Set<string>();

  const queueJob = async (job: MessageJob): Promise<void> => {
    // Saved on the phone before anything is sent. If that fails it still shows and sends from memory
    // (never dropped silently); it just won't survive a reload.
    if (!(await persistJob(job))) memoryOnly.add(job.id);
    setJobs([...snapshot.jobs, job]);
    host.broadcast();
    kick();
  };

  /**
   * The jobs as IndexedDB has them now (another tab may have queued, sent or retried some). This tab's
   * 'sending' marks and its memory-only jobs stay.
   */
  const reload = async () => {
    if (!host.kv() || !host.durable()) return;
    try {
      const stored = await readJobs();
      const memory = new Map(snapshot.jobs.map((j) => [j.id, j]));
      const merged: MessageJob[] = stored.map((j) => {
        const mine = memory.get(j.id);
        return mine && mine.state === 'sending' ? mine : j;
      });
      const ids = new Set(merged.map((j) => j.id));
      for (const j of snapshot.jobs) if (!ids.has(j.id) && (j.state === 'sending' || memoryOnly.has(j.id))) merged.push(j);
      const same = merged.length === snapshot.jobs.length && merged.every((j) => {
        const m = memory.get(j.id);
        return !!m && m.state === j.state && m.attempts === j.attempts && m.nextAttemptAt === j.nextAttemptAt;
      });
      if (!same) setJobs(merged);
    } catch {
      // keep what we have
    }
  };

  // ---- API ----
  const api: MessagingEngine = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    open(requestId) {
      openCounts.set(requestId, (openCounts.get(requestId) ?? 0) + 1);
      const t = snapshot.threads.get(requestId);
      if (!t || now() - t.loadedAt > THREAD_FRESH_MS) void loadLatest(requestId);
      ensurePoll();
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        const n = (openCounts.get(requestId) ?? 1) - 1;
        if (n <= 0) openCounts.delete(requestId);
        else openCounts.set(requestId, n);
        ensurePoll();
      };
    },

    isOpen: (requestId) => (openCounts.get(requestId) ?? 0) > 0,

    refresh(requestId) {
      void loadLatest(requestId);
    },

    async loadEarlier(requestId) {
      const t = snapshot.threads.get(requestId);
      const oldest = t?.messages[0];
      if (!t || !oldest || !t.hasEarlier || t.loadingEarlier) return;
      patchThread(requestId, { loadingEarlier: true });
      const gen = host.generation();
      const res = await host.call<ThreadPage>(threadPath(requestId, { at: oldest.createdAt, id: oldest.id }), { timeoutMs: SYNC.requestTimeoutMs });
      if (gen !== host.generation()) return;
      const cur = snapshot.threads.get(requestId) ?? t;
      if (res.ok && Array.isArray(res.data.messages)) {
        patchThread(requestId, { messages: mergeEarlierPage(cur.messages, res.data.messages), hasEarlier: res.data.hasEarlier, loadingEarlier: false });
        return;
      }
      if (!res.ok && res.kind === 'http' && res.status === 401) host.sessionExpired();
      patchThread(requestId, { loadingEarlier: false });
      host.showToast({ tone: 'amber', icon: 'cloud-off', title: "Couldn't load earlier messages", durationMs: 4_000 });
    },

    async send(requestId, body) {
      const text = cleanMessage(body);
      if (!text || messageLength(text) > MESSAGE_MAX) return false;
      const job: MessageJob = {
        eventId: host.eventId(),
        id: uuid(),
        kind: 'message',
        requestId,
        body: text,
        operator: host.staff() ?? '',
        createdAt: now(),
        state: 'pending',
        attempts: 0,
        nextAttemptAt: null,
        error: null,
      };
      await queueJob(job);
      return true;
    },

    retry(jobId) {
      const job = getJob(jobId);
      if (!job) return;
      const next = patchJob(jobId, { state: 'pending', attempts: 0, nextAttemptAt: null, error: null });
      if (next) void persistJob(next);
      host.broadcast();
      kick();
    },

    async discard(jobId) {
      await removeJob(jobId);
    },

    async unsend(requestId, messageId) {
      const t = snapshot.threads.get(requestId);
      const m = t?.messages.find((x) => x.id === messageId);
      if (m && Date.parse(m.createdAt) + UNSEND_WINDOW_MS < now()) {
        host.showToast({ tone: 'amber', icon: 'info', title: 'Too late to unsend', durationMs: 4_000 });
        return false;
      }
      if (!host.online()) {
        host.showToast({ tone: 'amber', icon: 'cloud-off', title: 'Needs a connection', durationMs: 4_000 });
        return false;
      }
      if (!(await host.ensureSession())) return false;
      const gen = host.generation();
      const res = await host.call<ActivityResponse>(
        `/api/requests/${encodeURIComponent(requestId)}/messages/${encodeURIComponent(messageId)}/unsend`,
        { method: 'POST', json: {}, timeoutMs: MESSAGE_TIMEOUT_MS },
      );
      if (gen !== host.generation()) return false;
      if (res.ok) {
        const cur = snapshot.threads.get(requestId);
        if (cur) {
          const next = { ...cur, messages: cur.messages.filter((x) => x.id !== messageId) };
          patchThread(requestId, next);
          writeThreadCache(requestId, next);
        }
        if (res.data.activity) host.patchActivity(requestId, res.data.activity);
        void loadLatest(requestId);
        return true;
      }
      if (res.kind === 'http' && res.status === 401) {
        host.sessionExpired();
        return false;
      }
      const tooLate = res.kind === 'http' && res.status === 422;
      host.showToast({ tone: 'amber', icon: tooLate ? 'info' : 'cloud-off', title: tooLate ? 'Too late to unsend' : "Couldn't unsend — try again", durationMs: 5_000 });
      return false;
    },

    async setEnroute(requestId, action, etaMinutes, opts) {
      // A new tap replaces my taps on this request that were not delivered (only the latest one counts).
      const me = host.staff();
      for (const j of snapshot.jobs) {
        if (j.kind === 'enroute' && j.requestId === requestId && j.state === 'failed' && jobIsMine(j, me)) await removeJob(j.id);
      }
      const job: MessageJob = {
        eventId: host.eventId(),
        id: uuid(),
        kind: 'enroute',
        requestId,
        enroute: { action, etaMinutes: action === 'set' ? etaMinutes : null, ...(opts?.etaAt !== undefined ? { etaAt: opts.etaAt } : {}) },
        operator: host.staff() ?? '',
        createdAt: now(),
        state: 'pending',
        attempts: 0,
        nextAttemptAt: null,
        error: null,
      };
      await queueJob(job);
    },

    async cancelEnroute(requestId, previous) {
      await api.setEnroute(requestId, 'cancel', null);
      host.showUndo(ENROUTE_CANCELLED, ENROUTE_UNDO_MS, () => {
        void api.setEnroute(requestId, 'set', previous.etaMinutes, { etaAt: previous.etaAt });
      });
    },

    markRead(requestId) {
      if (!running || !host.visible()) return;
      const row = host.row(requestId);
      const t = snapshot.threads.get(requestId);
      if (!t || t.loadedAt === 0) return;
      const upto = newestAt(t.messages);
      // Only someone else's message moves the cursor (lp_mark_read), and it is posted once per newest one.
      const latestOther = [...t.messages].reverse().find((m) => !m.mine);
      if (!upto || !latestOther) return;
      const unread = row?.unread ?? 0;
      if (readSent.get(requestId) === latestOther.createdAt) {
        // Already posted. The row may still count something newer the thread has not loaded yet: wait for it.
        if (unread === 0 || (row?.lastMessageAt ?? '') > latestOther.createdAt) return;
      }
      readSent.set(requestId, latestOther.createdAt);
      if (unread > 0) host.patchActivity(requestId, { unread: 0 });
      if (!host.online()) return;
      const gen = host.generation();
      void host
        .call<ActivityResponse>(`/api/requests/${encodeURIComponent(requestId)}/messages/read`, {
          method: 'POST',
          json: { upto },
          timeoutMs: MESSAGE_TIMEOUT_MS,
        })
        .then((res) => {
          if (gen !== host.generation()) return;
          if (res.ok && res.data.activity) host.patchActivity(requestId, res.data.activity);
          else if (!res.ok) readSent.delete(requestId); // try again next time it shows
        });
    },

    unsentCount: () => snapshot.jobs.length,

    start() {
      running = true;
      ensurePoll();
      scheduleWork();
      doc?.addEventListener('visibilitychange', pollOpen);
    },

    stop() {
      running = false;
      doc?.removeEventListener('visibilitychange', pollOpen);
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
      if (workTimer) clearTimeout(workTimer);
      workTimer = undefined;
    },

    async hydrate() {
      try {
        const stored = await readJobs();
        const known = new Set(snapshot.jobs.map((j) => j.id));
        if (stored.length) setJobs([...snapshot.jobs, ...stored.filter((j) => !known.has(j.id))]);
      } catch {
        // An unreadable store behaves as empty.
      }
    },

    reload,
    kick,

    async clear(discardJobs) {
      openCounts.clear();
      readSent.clear();
      if (discardJobs) memoryOnly.clear();
      ensurePoll();
      snapshot = { threads: new Map(), jobs: discardJobs ? [] : snapshot.jobs };
      emit();
      if (discardJobs) {
        await host.enqueue(async (store) => {
          for (const k of await store.keys()) if (k.startsWith('mjob:')) await store.del(k);
        });
      }
    },
  };
  return api;
}

/** "Rae C." / team short for a session staff string (my own queued bubbles). */
export function meFor(staff: string | null, teams: ReadonlyArray<{ label: string; short: string }> = []): { by: string; team: string } {
  const p = parseStaff(staff, teams);
  return { by: senderShort(staff), team: p.teamShort || p.team };
}

/** Is this job mine (the signed-in staff's)? */
export const jobIsMine = (job: MessageJob, staff: string | null) => !job.operator || sameStaff(job.operator, staff) || canonStaff(job.operator) === canonStaff(staff);
