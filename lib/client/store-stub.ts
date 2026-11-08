// In-memory STUB of the AppStore contract, fed by synthetic rows (stub-data.ts). No network, no
// IndexedDB. It follows the same domain rules (transitions, creator checks, versions, undo) so screens
// behave plausibly. Phase 1b (C) replaces its use in lib/client/store.tsx with the real store; after that
// only tests import it (v2.2 A25: the stub and stub-data must not be in the production first load).
import type { RequestDetail, RequestSummary, Stats } from '../api-types';
import {
  STATUS,
  canTransition,
  isCreatorOnlyTransition,
  isInMedical,
  joinName,
  postShort,
  sameStaff,
  splitName,
  statusMeta,
  undoTarget,
  type SettableStatus,
  type StatusKind,
} from '../domain';
import { formatCaseNumber, minutesSince } from '../format';
import { swapOverlayFields } from './swap';
import { toCreateBody } from './form-values';
import {
  createServerState,
  type AlertEvent,
  type AppStore,
  type CreateInput,
  type CreateResult,
  type DraftPhoto,
  type MutationResult,
  type PreparePhotoOptions,
  type RequestDraft,
  type StoreActions,
  type StoreState,
  type ToastItem,
} from './store-contract';
import { UNDO_MS } from './constants';
import { readPrefs, writePref } from './prefs';
import { STUB_SESSION, stubDetail, stubRows } from './stub-data';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq += 1)}`;

export interface StubOptions {
  eventTimezone: string;
  now?: number;
  /** Start with no rows (to render empty states). */
  empty?: boolean;
}

type PostCount = Stats['byPost'][number];

/** Same as lp_stats byPost after the fixed posts: Other grouped by its location (case-insensitive), legacy posts as themselves. */
function otherPosts(rows: readonly RequestSummary[]): PostCount[] {
  const groups = new Map<string, PostCount>();
  for (const r of rows) {
    const isOther = r.reportingLocation === 'Other';
    const key = isOther ? `Other|${(r.otherLocation ?? '').trim().toLowerCase()}` : r.reportingLocation;
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, { reportingLocation: r.reportingLocation, otherLocation: isOther ? (r.otherLocation?.trim() ?? null) : null, postShort: r.postShort, count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.postShort.localeCompare(b.postShort));
}

export function createStubStore(options: StubOptions): AppStore {
  const now = options.now ?? Date.now();
  const rows = options.empty ? [] : stubRows(now);
  let state: StoreState = {
    hydrated: true,
    hasData: true,
    confirmed: new Map(rows.map((r) => [r.id, r])),
    pending: new Map(),
    outbox: [],
    outboxPrompt: null,
    connection: 'live',
    syncing: false,
    lastSyncAt: new Date(now).toISOString(),
    lastSyncLocalAt: now,
    session: { status: 'active', ...STUB_SESSION, expiresAt: new Date(now + 12 * 3600_000).toISOString() },
    myIds: new Set(),
    // Backed by lib/client/prefs.ts exactly as the real store is (DEFAULT_PREFS on the server / in tests).
    prefs: readPrefs(),
    toasts: [],
    snackbar: null,
    updateReady: false,
    offlineReady: false,
    generation: 0,
    eventTimezone: options.eventTimezone,
    durableStorage: true,
  };

  const listeners = new Set<() => void>();
  const alertListeners = new Set<(a: AlertEvent) => void>();
  const set = (patch: Partial<StoreState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };
  const putRow = (row: RequestSummary) => {
    const confirmed = new Map(state.confirmed);
    confirmed.set(row.id, row);
    set({ confirmed });
  };
  const stamp = () => new Date().toISOString();
  const staff = () => state.session.staff ?? STUB_SESSION.staff;
  let draft: RequestDraft | null = null;
  const undoable = new Map<string, { id: string; status: SettableStatus; version: number }>();

  const fail = (reason: Extract<MutationResult, { ok: false }>['reason'], message: string): MutationResult => ({
    ok: false,
    reason,
    message,
  });

  const showToast = (toast: Omit<ToastItem, 'id'>) => {
    const id = nextId('toast');
    set({ toasts: [...state.toasts, { ...toast, id }] });
    if (toast.durationMs) setTimeout(() => actions.dismissToast(id), toast.durationMs);
    return id;
  };

  const applyStatus = (id: string, to: SettableStatus, kind: StatusKind): MutationResult => {
    const row = state.confirmed.get(id);
    if (!row) return fail('not_found', 'Request not found');
    if (row.status === to) return { ok: true, changed: false, request: row };
    if (!canTransition(row.status, to)) return fail('invalid', "That change isn't allowed now");
    if (isCreatorOnlyTransition(row.status, to) && !sameStaff(row.createdBy, staff())) {
      return fail('forbidden', 'Only the person who logged it can reopen it');
    }
    const t = stamp();
    const next: RequestSummary = {
      ...row,
      status: to,
      foundAt: to === STATUS.inMedical ? (row.foundAt ?? t) : row.foundAt,
      reunionStartedAt: to === STATUS.inMedical ? t : to === STATUS.waiting || to === STATUS.notInMedical ? null : row.reunionStartedAt,
      closedAt: to === STATUS.reunited || to === STATUS.discharged ? t : null,
      updatedBy: staff(),
      updatedAt: t,
      rowVersion: row.rowVersion + 1,
    };
    putRow(next);
    if (kind !== 'undo' && ['answer', 'change', 'reunite', 'inform'].includes(kind)) {
      const back = undoTarget(row.status);
      if (back) {
        const snackId = nextId('undo');
        undoable.set(snackId, { id, status: back as SettableStatus, version: next.rowVersion });
        set({ snackbar: { id: snackId, message: `${formatCaseNumber(row.caseNumber)} · ${statusMeta(to).shortLabel}`, expiresAt: Date.now() + UNDO_MS } });
        if (undoHolds === 0) armUndo(snackId);
      }
    }
    return { ok: true, changed: true, request: next };
  };

  // The Undo countdown, paused while something covers the bar (holdUndo, as the real store).
  let snackTimer: ReturnType<typeof setTimeout> | undefined;
  let undoHolds = 0;
  const armUndo = (snackId: string) => {
    if (snackTimer) clearTimeout(snackTimer);
    snackTimer = setTimeout(() => {
      snackTimer = undefined;
      if (state.snackbar?.id === snackId) set({ snackbar: null });
      undoable.delete(snackId);
    }, UNDO_MS);
  };

  const actions: StoreActions = {
    syncNow() {
      set({ syncing: true });
      setTimeout(() => set({ syncing: false, lastSyncAt: stamp(), lastSyncLocalAt: Date.now() }), 300);
    },
    async setStatus(id, status, kind) {
      return applyStatus(id, status, kind);
    },
    async undo(snackbarId) {
      const u = undoable.get(snackbarId);
      if (!u) return null;
      undoable.delete(snackbarId);
      set({ snackbar: null });
      return applyStatus(u.id, u.status, 'undo');
    },
    dismissSnackbar() {
      set({ snackbar: null });
    },
    holdUndo() {
      undoHolds += 1;
      if (snackTimer) clearTimeout(snackTimer);
      snackTimer = undefined;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        undoHolds -= 1;
        const snack = state.snackbar;
        if (undoHolds > 0 || !snack || !undoable.has(snack.id)) return;
        set({ snackbar: { ...snack, expiresAt: Date.now() + UNDO_MS } });
        armUndo(snack.id);
      };
    },
    async create(input: CreateInput): Promise<CreateResult> {
      const body = toCreateBody(input.values, input.clientMutationId);
      const existing = [...state.confirmed.values()].find((r) => r.clientMutationId === input.clientMutationId);
      if (existing) return { outcome: 'sent', request: existing };
      const caseNumber = Math.max(1000, ...[...state.confirmed.values()].map((r) => r.caseNumber)) + 1;
      const t = stamp();
      const { firstName, lastName } = splitName(body.name ?? null);
      const row: RequestSummary = {
        id: crypto.randomUUID(),
        clientMutationId: input.clientMutationId,
        caseNumber,
        firstName,
        lastName,
        age: body.age === undefined || body.age === null ? null : String(body.age),
        gender: body.gender ?? null,
        heightBuild: body.heightBuild ?? null,
        hair: body.hair ?? null,
        identifyingFeatures: body.identifyingFeatures ?? null,
        physicalDescription: body.physicalDescription ?? null,
        lastSeen: body.lastSeen ?? null,
        clothing: body.clothing ?? null,
        additionalNotes: body.additionalNotes ?? null,
        reportingLocation: body.reportingLocation,
        otherLocation: body.otherLocation ?? null,
        contactName: body.contactName ?? null,
        contactPhone: body.contactPhone ?? null,
        contactRelationship: body.contactRelationship ?? null,
        contactNotes: body.contactNotes ?? null,
        status: STATUS.waiting,
        createdBy: staff(),
        updatedBy: staff(),
        createdAt: t,
        updatedAt: t,
        foundAt: null,
        reunionStartedAt: null,
        closedAt: null,
        rowVersion: input.photos.length,
        firstPhotoId: input.photos[0]?.photoId ?? null,
        photoCount: input.photos.length,
        name: joinName(firstName, lastName),
        postShort: postShort(body.reportingLocation, body.otherLocation ?? null),
      };
      putRow(row);
      set({ myIds: new Set([...state.myIds, row.id]) });
      showToast({ tone: 'green', icon: 'check', title: `${formatCaseNumber(caseNumber)} saved`, durationMs: 4000 });
      return { outcome: 'sent', request: row };
    },
    async updateFields(id, patch, baseVersion) {
      const row = state.confirmed.get(id);
      if (!row) return fail('not_found', 'Request not found');
      if (row.rowVersion !== baseVersion) return { ok: false, reason: 'conflict', message: 'Updated by someone else', latest: row };
      const next: RequestSummary = { ...row };
      if (patch.name !== undefined) Object.assign(next, splitName(patch.name), { name: patch.name ?? '' });
      for (const [key, value] of Object.entries(patch)) {
        if (key !== 'name') (next as unknown as Record<string, unknown>)[key] = value ?? null;
      }
      next.postShort = postShort(next.reportingLocation, next.otherLocation);
      next.updatedBy = staff();
      next.updatedAt = stamp();
      next.rowVersion = row.rowVersion + 1;
      putRow(next);
      return { ok: true, changed: true, request: next };
    },
    async setMedicalLocation(id, location) {
      const row = state.confirmed.get(id);
      if (!row) return fail('not_found', 'Request not found');
      const value = location === null ? null : location.trim() || null;
      if ((row.medicalLocation ?? null) === value) return { ok: true, changed: false, request: row };
      const next: RequestSummary = { ...row, medicalLocation: value, updatedBy: staff(), updatedAt: stamp(), rowVersion: row.rowVersion + 1 };
      putRow(next);
      return { ok: true, changed: true, request: next };
    },
    async swap(id, swapAction) {
      const row = state.confirmed.get(id);
      if (!row) return fail('not_found', 'Request not found');
      const t = stamp();
      const next: RequestSummary = {
        ...row,
        ...swapOverlayFields(swapAction, staff(), t),
        updatedBy: staff(),
        updatedAt: t,
        rowVersion: row.rowVersion + 1,
      };
      putRow(next);
      return { ok: true, changed: true, request: next };
    },
    async cancel(id) {
      const row = state.confirmed.get(id);
      if (!row) return fail('not_found', 'Request not found');
      if (!sameStaff(row.createdBy, staff())) return fail('forbidden', 'Only the person who logged it can cancel it');
      if (row.status === STATUS.cancelled) return { ok: true, changed: false, request: row };
      if (row.status !== STATUS.waiting) return fail('invalid', 'Only a request waiting for check can be cancelled');
      const t = stamp();
      const next = { ...row, status: STATUS.cancelled, closedAt: t, updatedAt: t, updatedBy: staff(), rowVersion: row.rowVersion + 1 };
      putRow(next);
      return { ok: true, changed: true, request: next };
    },
    async addPhotos(id, photos) {
      const row = state.confirmed.get(id);
      if (!row) return { added: 0, failed: photos.length };
      const room = Math.max(0, 3 - row.photoCount);
      const added = Math.min(room, photos.length);
      putRow({ ...row, photoCount: row.photoCount + added, firstPhotoId: row.firstPhotoId ?? photos[0]?.photoId ?? null, rowVersion: row.rowVersion + added });
      return { added, failed: photos.length - added };
    },
    async preparePhoto(file: File, _options?: PreparePhotoOptions): Promise<DraftPhoto> {
      return { photoId: crypto.randomUUID(), blob: file, thumbBlob: file, width: 0, height: 0 };
    },
    async fetchDetail(id): Promise<RequestDetail> {
      const row = state.confirmed.get(id);
      if (!row) throw Object.assign(new Error('not_found'), { reason: 'not_found' });
      return stubDetail(row);
    },
    async fetchStats(_range?: unknown): Promise<Stats> {
      const all = [...state.confirmed.values()];
      const open = all.filter((r) => r.status === STATUS.waiting || isInMedical(r.status));
      const oldest = all.filter((r) => r.status === STATUS.waiting).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      const fixed = ['FA 3 – Kinetic', 'FA 4 – Oasis', 'Command', 'Base'];
      return {
        open: { waiting: all.filter((r) => r.status === STATUS.waiting).length, inMedical: all.filter((r) => isInMedical(r.status)).length },
        notInMedical: all.filter((r) => r.status === STATUS.notInMedical).length,
        reunited: all.filter((r) => r.status === STATUS.reunited).length,
        discharged: all.filter((r) => r.status === STATUS.discharged).length,
        cancelled: all.filter((r) => r.status === STATUS.cancelled).length,
        total: all.length,
        longestWait: oldest
          ? { id: oldest.id, caseNumber: oldest.caseNumber, reportingLocation: oldest.reportingLocation, otherLocation: oldest.otherLocation, postShort: oldest.postShort, minutes: minutesSince(oldest.createdAt) }
          : null,
        avgAnswerMinutes: 9,
        avgReuniteMinutes: 18,
        loggedLastHour: 6,
        byPost: [
          ...fixed.map((loc) => ({ reportingLocation: loc, otherLocation: null, postShort: postShort(loc), count: open.filter((r) => r.reportingLocation === loc).length })),
          ...otherPosts(open.filter((r) => !fixed.includes(r.reportingLocation))),
        ],
        recent: [...all]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 5)
          .map((r) => ({ id: r.id, caseNumber: r.caseNumber, name: r.name || null, status: r.status, postShort: r.postShort, updatedAt: r.updatedAt })),
        serverTime: stamp(),
      };
    },
    outbox: {
      retry() {},
      async discard(mutationId) {
        set({ outbox: state.outbox.filter((o) => o.mutationId !== mutationId) });
      },
      async update(mutationId, payload) {
        set({ outbox: state.outbox.map((o) => (o.mutationId === mutationId ? { ...o, payload } : o)) });
      },
      resend() {},
      async answerPrompt() {
        set({ outboxPrompt: null });
      },
    },
    draft: {
      async load() {
        return draft;
      },
      save(d) {
        draft = d;
      },
      async flush() {},
      async clear() {
        draft = null;
      },
    },
    async signOut(opts) {
      if (state.outbox.length > 0 && !opts?.discardOutbox) return { ok: false, reason: 'outbox', count: state.outbox.length };
      set({ session: { status: 'signed_out', staffName: null, team: null, staff: null, expiresAt: null }, generation: state.generation + 1 });
      return { ok: true };
    },
    setPref(key, value) {
      writePref(key, value);
      set({ prefs: { ...state.prefs, [key]: value } });
    },
    showToast,
    dismissToast(id) {
      set({ toasts: state.toasts.filter((t) => t.id !== id) });
    },
    subscribeAlerts(listener) {
      alertListeners.add(listener);
      return () => alertListeners.delete(listener);
    },
    async applyUpdate() {
      return false;
    },
  };

  // Construction above starts nothing (server-render invariants, store-contract.ts); the stub has no
  // side effects to start(). Hydration uses the shared server state.
  const serverState = createServerState(options.eventTimezone);

  return {
    getState: () => state,
    getServerState: () => serverState,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    actions,
  };
}
