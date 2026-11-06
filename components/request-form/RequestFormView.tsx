'use client';
// Full-screen New request / Edit / Needs-attention editor (spec §8 New request, v2.1 A10/A13/A20/A22–A24,
// A33, A39):
//   ?new=1                         → mode 'new': every create goes through the store outbox (A13); the draft
//                                    (values, compressed photos, timing, clientMutationId) is restored on
//                                    mount, saved on each change (debounced by the store), flushed when a
//                                    photo is added and on pagehide / hide (A20), cleared after a send or a
//                                    queued save, or on Cancel (confirm when not empty).
//   ?r=<id>&edit=person|friend|all → mode 'edit': prefilled; captures {base, baseVersion} when editing starts
//                                    and sends only the changed keys with that version; a 409 shows the
//                                    conflict review (latest data, the user's edits kept, nothing resent).
//   ?outbox=<mutationId>           → mode 'outbox': fix and resend a needs-attention job with the same
//                                    mutationId; photos read-only; the rejected field is pointed at.
// Presentation (desktop-new-tablet.html frame 1): the phone page under 768 px, a 480 px side sheet at
// 768–1023 and a centred 760 px two-column modal from 1024, chosen by viewport width unless the caller
// forces one (`presentation`). Sheet and modal are dialogs over whatever page the shell keeps behind them:
// Esc, × or a click outside close without discarding (a new request keeps its draft, exactly as leaving
// does on the phone; edit and the needs-attention editor ask before dropping changes, as Cancel does),
// and ⌘↵ / Ctrl+↵ sends.
import { AlertDialog, Button, Flex } from '@radix-ui/themes';
import { CircleAlert } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Banner } from '@/components/ui/Banner';
import { EmptyState } from '@/components/ui/EmptyState';
import { goBack, navigate, type NavParams } from '@/lib/client/nav';
import {
  EMPTY_FORM_VALUES,
  canSend,
  formErrorsFromField,
  formValuesFromCreateBody,
  formValuesFromRequest,
  hasAnyDetail,
  toCreateBody,
  toPatch,
  type RequestFormValues,
} from '@/lib/client/form-values';
import {
  useAppStore,
  useIsLoading,
  useRequest,
  useStoreSelector,
  type CreateResult,
  type DraftPhoto,
  type MutationResult,
  type RequestDraft,
  type StoreState,
} from '@/lib/client/store-contract';
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { isPostValue, isUuid, type EditSection, type PhotoTiming } from '@/lib/domain';
import { formatCaseNumber } from '@/lib/format';
import {
  canSaveEdit,
  findDuplicate,
  legacyPostOf,
  newUuid,
  onlyOutsideFormChanged,
  rebaseOnConflict,
  sameDuplicate,
  visibleErrors,
  type DuplicateRef,
  type TheirChange,
} from './form-logic';
import { FormSurface } from './FormSurface';
import {
  PresentationContext,
  isOverlay,
  useFormPresentation,
  usePresentation,
  type FormPresentationChoice,
} from './presentation';
import { RequestForm } from './RequestForm';
import './request-form.css';

export type RequestFormViewProps = (
  | { mode: 'new' }
  | { mode: 'edit'; id: string; section: EditSection }
  | { mode: 'outbox'; mutationId: string }
) & {
  /**
   * 'auto' (default): the phone page under 768 px, the side sheet at 768–1023, the modal from 1024.
   * 'page' | 'sheet' | 'modal' force one. Sheet and modal render as a dialog (portalled, with its own
   * scrim) over whatever the shell keeps on screen behind them.
   */
  presentation?: FormPresentationChoice;
};

export function RequestFormView(props: RequestFormViewProps) {
  const presentation = useFormPresentation(props.presentation);
  return <PresentationContext.Provider value={presentation}>{modeView(props)}</PresentationContext.Provider>;
}

/**
 * The same component under the name the desktop shell asks for: render it for ?new=1, ?r=…&edit= and
 * ?outbox= over the list (and the docked request) from 768 px. Under 768 px it is the phone page.
 */
export const RequestFormOverlay = RequestFormView;

function modeView(props: RequestFormViewProps) {
  switch (props.mode) {
    case 'new':
      return <NewRequest />;
    case 'edit':
      return <EditRequest key={props.id} id={props.id} section={props.section} />;
    case 'outbox':
      return <OutboxEditor key={props.mutationId} mutationId={props.mutationId} />;
  }
}

// ---------------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------------

// Narrow selectors: a poll that changes nothing here never re-renders the form while someone types.
const selectOffline = (s: StoreState) => s.connection === 'offline';
const selectDurable = (s: StoreState) => s.durableStorage;
const selectHydrated = (s: StoreState) => s.hydrated;
const noop = () => undefined;

/** "Similar open request: LP-1009" — the newest open request with the same name (case-insensitive). */
function useDuplicate(name: string, exclude: { id?: string | null; clientMutationId?: string | null }): DuplicateRef | null {
  const deferred = useDeferredValue(name);
  const { id = null, clientMutationId = null } = exclude;
  const selector = useCallback(
    (s: StoreState) => findDuplicate(s.confirmed.values(), deferred, { id, clientMutationId }),
    [deferred, id, clientMutationId],
  );
  return useStoreSelector(selector, sameDuplicate);
}

interface ConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  keepLabel: string;
  confirmLabel: string;
  onConfirm: () => void;
}

function Confirm({ open, onOpenChange, title, keepLabel, confirmLabel, onConfirm }: ConfirmProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Content maxWidth="340px" aria-describedby={undefined}>
        <AlertDialog.Title size="4" weight="medium" mb="4">
          {title}
        </AlertDialog.Title>
        <Flex gap="3" justify="end">
          <AlertDialog.Cancel>
            <Button variant="soft" color="gray" size="3" className="lp-hit">
              {keepLabel}
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action>
            <Button color="red" size="3" className="lp-hit lp-solid-accent" onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

/**
 * Close the view once. Esc, x and a click outside can all land before the history pop does, and a second
 * history.back() would step out of the list behind the dialog.
 */
function useLeaveOnce(): (fallback?: NavParams) => void {
  const left = useRef(false);
  return useCallback((fallback: NavParams = {}) => {
    if (left.current) return;
    left.current = true;
    goBack(fallback);
  }, []);
}

/** The frame without a form: while loading, or when the request / job is gone. */
function FormFrame({ title, columns = 2, children }: { title: string; columns?: 1 | 2; children?: ReactNode }) {
  const presentation = usePresentation();
  const leave = useLeaveOnce();
  const close = () => leave();
  return (
    <FormSurface presentation={presentation} title={title} onCancel={close} onDismiss={close} columns={columns}>
      <div className="lp-rf-scroll lp-rf-frame" style={{ display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </FormSurface>
  );
}

// ---------------------------------------------------------------------------------------------------
// New request
// ---------------------------------------------------------------------------------------------------

interface NewState {
  clientMutationId: string;
  values: RequestFormValues;
  photos: DraftPhoto[];
  timing: PhotoTiming;
}

function NewRequest() {
  const store = useAppStore();
  const { actions } = store;
  const overlay = isOverlay(usePresentation());
  const leave = useLeaveOnce();
  const offline = useStoreSelector(selectOffline);
  const durable = useStoreSelector(selectDurable);
  const [form, setForm] = useState<NewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // The draft was cleared (sent, queued, cancelled): nothing may write it again.
  const closed = useRef(false);
  // A non-empty draft was saved during this visit (so emptying the form clears it).
  const saved = useRef(false);
  // A second tap before the first re-render must not send twice.
  const inFlight = useRef(false);
  const latest = useRef<NewState | null>(null);
  useEffect(() => {
    latest.current = form;
  }, [form]);

  // Warm the photo-compression chunk now, while there may still be signal: the photo slot needs it, and a
  // phone that goes offline with the form open could not fetch it later.
  useEffect(() => {
    void import('@/lib/client/image').catch(noop);
  }, []);

  // Restore the draft (or start one) once, on mount.
  useEffect(() => {
    let live = true;
    const lastPost = store.getState().prefs.lastPost;
    const withPost = (v: RequestFormValues): RequestFormValues =>
      v.reportingLocation || !lastPost
        ? v
        : { ...v, reportingLocation: lastPost.reportingLocation, otherLocation: lastPost.otherLocation ?? '' };
    const start = (draft: RequestDraft | null) => {
      if (!live) return;
      if (draft && isUuid(draft.clientMutationId)) {
        const values = { ...EMPTY_FORM_VALUES, ...draft.values };
        if (values.reportingLocation && !isPostValue(values.reportingLocation)) values.reportingLocation = '';
        saved.current = true;
        setForm({
          clientMutationId: draft.clientMutationId,
          values: withPost(values),
          photos: Array.isArray(draft.photos) ? draft.photos : [],
          timing: draft.photoTiming === 'older' ? 'older' : 'today',
        });
      } else {
        setForm({ clientMutationId: newUuid(), values: withPost({ ...EMPTY_FORM_VALUES }), photos: [], timing: 'today' });
      }
    };
    actions.draft.load().then(start, () => start(null));
    return () => {
      live = false;
    };
  }, [actions, store]);

  // Save on each change (the store debounces). An emptied form clears the draft instead.
  useEffect(() => {
    if (!form || closed.current) return;
    if (!hasAnyDetail(form.values, form.photos.length)) {
      if (saved.current) {
        saved.current = false;
        void actions.draft.clear().catch(noop);
      }
      return;
    }
    saved.current = true;
    actions.draft.save({ clientMutationId: form.clientMutationId, values: form.values, photos: form.photos, photoTiming: form.timing, updatedAt: Date.now() });
  }, [form, actions]);

  // Flush any pending save when the page is hidden or closed (iOS may kill a backgrounded tab), and when
  // leaving the view without Cancel (back button).
  useEffect(() => {
    const flush = () => {
      if (!closed.current) void actions.draft.flush().catch(noop);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, [actions]);

  const duplicateOf = useDuplicate(form?.values.name ?? '', { clientMutationId: form?.clientMutationId ?? null });

  // The draft loads from IndexedDB in a few ms: an empty dialog would open and then grow, so the
  // overlay waits for it (the phone keeps its full-screen frame).
  if (!form) return overlay ? null : <FormFrame title="New request" />;

  const update = (patch: Partial<NewState>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const onPhotosChange = (photos: DraftPhoto[]) => {
    const current = latest.current ?? form;
    update({ photos });
    // A20: a photo is the slowest thing to redo (iOS may reload the page after the camera): write now.
    if (photos.length > current.photos.length && !closed.current) {
      saved.current = true;
      actions.draft.save({ clientMutationId: current.clientMutationId, values: current.values, photos, photoTiming: current.timing, updatedAt: Date.now() });
      void actions.draft.flush().catch(noop);
    }
  };

  const clearDraft = async () => {
    closed.current = true;
    // Flush first so a pending debounced save can't land after the clear.
    await actions.draft.flush().catch(noop);
    await actions.draft.clear().catch(noop);
  };

  const submit = async () => {
    if (inFlight.current || !canSend(form.values, form.photos.length) || (offline && !durable)) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    let result: CreateResult;
    try {
      result = await actions.create({ values: form.values, clientMutationId: form.clientMutationId, photos: form.photos, photoTiming: form.timing });
    } catch {
      result = { outcome: 'not_saved', message: "Couldn't save — check signal and try again" };
    }
    if (result.outcome === 'not_saved') {
      inFlight.current = false;
      setBusy(false);
      setFailure(result.message);
      return;
    }
    await clearDraft();
    // The store has already announced the outcome ("LP-1014 saved" / "Saved on this phone").
    // A definitive rejection stays in the outbox: show it in the needs-attention editor, error pointed at.
    if (result.outcome === 'needs_attention') navigate({ outbox: result.mutationId }, { replace: true });
    else leave();
  };

  const cancel = () => {
    if (hasAnyDetail(form.values, form.photos.length)) setConfirmCancel(true);
    else void clearDraft().then(() => leave());
  };

  const noStorageOffline = offline && !durable;
  const notice = failure ? (
    <Banner tone="red" icon="error">
      {failure}
    </Banner>
  ) : noStorageOffline ? (
    <Banner tone="amber" icon="offline">
      Can&apos;t save offline on this phone
    </Banner>
  ) : null;

  return (
    <>
      <RequestForm
        mode="create"
        section="all"
        values={form.values}
        onChange={(values) => update({ values })}
        photos={form.photos}
        onPhotosChange={onPhotosChange}
        photoTiming={form.timing}
        onPhotoTimingChange={(timing) => update({ timing })}
        offline={offline}
        busy={busy}
        notice={notice}
        duplicateOf={duplicateOf}
        submitLabel={offline ? 'Save offline' : 'Send request'}
        submitDisabled={!canSend(form.values, form.photos.length) || noStorageOffline}
        onSubmit={() => void submit()}
        onCancel={cancel}
        // Leaving keeps the draft (flushed on unmount), as the phone's back button does.
        onDismiss={() => leave()}
        onPostPicked={(choice) => actions.setPref('lastPost', { reportingLocation: choice.reportingLocation, otherLocation: choice.otherLocation })}
      />
      <Confirm
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Discard this request?"
        keepLabel="Keep"
        confirmLabel="Discard"
        onConfirm={() => void clearDraft().then(() => leave())}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------
// Edit (A10, A24)
// ---------------------------------------------------------------------------------------------------

/** How long Edit, opened by a reload or a link, waits for this page's first sync before using the cache. */
export const EDIT_FIRST_SYNC_WAIT_MS = 3_000;

const selectSynced = (s: StoreState) => s.lastSyncAt !== null;
const selectConnectionState = (s: StoreState) => s.connection;

/**
 * Edit captures where editing starts (A10), so it should start from the server's latest, not from a
 * cached row a reload brought back: until this page has synced once, wait (briefly, and only while the
 * log is reachable). Latches: once ready, a later connection change never unmounts the form.
 */
function useReadyToEdit(): boolean {
  const synced = useStoreSelector(selectSynced);
  const connection = useStoreSelector(selectConnectionState);
  const [timedOut, setTimedOut] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (synced || ready) return;
    const t = window.setTimeout(() => setTimedOut(true), EDIT_FIRST_SYNC_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [synced, ready]);
  if (!ready && (synced || timedOut || connection !== 'live')) setReady(true);
  return ready || synced || timedOut || connection !== 'live';
}

function EditRequest({ id, section }: { id: string; section: EditSection }) {
  const row = useRequest(id);
  const loading = useIsLoading();
  const ready = useReadyToEdit();
  if (!row) {
    return (
      <FormFrame title="Edit details" columns={section === 'all' ? 2 : 1}>
        {loading ? null : <EmptyState icon="search" title="Request not found" action={{ label: 'Back', onClick: () => goBack({}) }} />}
      </FormFrame>
    );
  }
  if (!ready) return <FormFrame title={`Edit ${formatCaseNumber(row.caseNumber)}`} columns={section === 'all' ? 2 : 1} />;
  return <EditForm id={id} section={section} row={row} />;
}

interface EditState {
  /** The version editing started from (sent as expectedVersion). */
  baseVersion: number;
  /** The values editing started from (changed keys are diffed against them). */
  base: RequestFormValues;
  values: RequestFormValues;
  legacyPost: string | null;
}

function editStateFrom(row: RequestSummary): EditState {
  const values = formValuesFromRequest(row);
  return { baseVersion: row.rowVersion, base: values, values, legacyPost: legacyPostOf(row) };
}

function EditForm({ id, section, row }: { id: string; section: EditSection; row: RequestSummary }) {
  const store = useAppStore();
  const { actions } = store;
  const offline = useStoreSelector(selectOffline);
  // Captured once, when editing starts (A10): later syncs never touch what the user is editing.
  const [form, setForm] = useState<EditState>(() => editStateFrom(row));
  const [review, setReview] = useState<TheirChange[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // Remounts the form after a review, so it starts fresh on the latest data (focus, chips, scroll).
  const [revision, setRevision] = useState(0);
  const inFlight = useRef(false);
  const leave = useLeaveOnce();

  const close = () => leave({ r: id });

  const startReview = (latestRow: RequestSummary) => {
    const latestValues = formValuesFromRequest(latestRow);
    const next = rebaseOnConflict(form.base, form.values, latestValues, section);
    setForm({ baseVersion: latestRow.rowVersion, base: latestValues, values: next.values, legacyPost: legacyPostOf(latestRow) });
    setReview(next.theirs);
    setFailure(null);
    setRevision((n) => n + 1);
  };

  const save = async () => {
    if (inFlight.current || offline) return;
    const patch = toPatch(form.base, form.values);
    if (!patch) {
      close();
      return;
    }
    if (!canSaveEdit(form.base, form.values)) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    const send = async (version: number): Promise<MutationResult> => {
      try {
        return await actions.updateFields(id, patch, version, { quiet: true });
      } catch {
        return { ok: false, reason: 'failed', message: "Couldn't save — check signal and try again" };
      }
    };
    let version = form.baseVersion;
    let result = await send(version);
    if (!result.ok && result.reason === 'conflict') {
      // Only a status or a photo moved on since editing started: nothing to review, so send once more on
      // the newer version (the server diffs per key, so nobody's change is overwritten).
      const latest = result.latest ?? store.getState().confirmed.get(id);
      if (latest && latest.rowVersion !== version && onlyOutsideFormChanged(form.base, form.legacyPost, latest)) {
        version = latest.rowVersion;
        result = await send(version);
      }
    }
    if (result.ok) {
      close();
      return;
    }
    inFlight.current = false;
    setBusy(false);
    switch (result.reason) {
      case 'conflict': {
        const latest = result.latest ?? store.getState().confirmed.get(id);
        if (latest && latest.rowVersion !== version) startReview(latest);
        else setReview([]);
        return;
      }
      case 'unauthorized':
        // The store sends the user to sign-in; the edits stay in the form.
        return;
      default:
        // Quiet mutation: the form shows the failure (no store toast); the edits stay in the form.
        setFailure(result.message);
    }
  };

  const changed = toPatch(form.base, form.values) !== null;
  const cancel = () => {
    if (changed) setConfirmCancel(true);
    else close();
  };

  // A newer version that changed nothing this form holds (a status answer, a photo): carry on from it,
  // silently. Otherwise someone else changed a field while this was open: offer the review.
  const outsideOnly = row.rowVersion !== form.baseVersion && !busy && review === null && onlyOutsideFormChanged(form.base, form.legacyPost, row);
  if (outsideOnly) setForm((f) => ({ ...f, baseVersion: row.rowVersion }));
  const movedOn = row.rowVersion !== form.baseVersion && !busy && !outsideOnly;

  // null when there is nothing to say, so the form adds no empty notice row.
  const notice = editNotice({
    review,
    failure,
    offline,
    movedOn: movedOn && review === null,
    onReview: () => startReview(row),
  });

  return (
    <>
      <RequestForm
        key={revision}
        mode="edit"
        section={section}
        values={form.values}
        onChange={(values) => setForm((f) => ({ ...f, values }))}
        photos={NO_PHOTOS}
        onPhotosChange={noop}
        photoTiming="today"
        onPhotoTimingChange={noop}
        offline={false}
        busy={busy}
        notice={notice}
        title={`Edit ${formatCaseNumber(row.caseNumber)}`}
        submitLabel="Save"
        submitDisabled={offline || !canSaveEdit(form.base, form.values)}
        onSubmit={() => void save()}
        onCancel={cancel}
        legacyPost={form.legacyPost}
      />
      <Confirm
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Discard changes?"
        keepLabel="Keep editing"
        confirmLabel="Discard"
        onConfirm={close}
      />
    </>
  );
}

const NO_PHOTOS: readonly DraftPhoto[] = Object.freeze([]);

function editNotice({
  review,
  failure,
  offline,
  movedOn,
  onReview,
}: {
  review: TheirChange[] | null;
  failure: string | null;
  offline: boolean;
  movedOn: boolean;
  onReview: () => void;
}): ReactNode {
  const parts: ReactNode[] = [];
  if (offline) {
    parts.push(
      <Banner key="offline" tone="amber" icon="offline">
        Needs a connection
      </Banner>,
    );
  }
  if (review) {
    parts.push(
      <Banner key="review" tone="amber" icon="conflict">
        Someone else just updated this. Your changes are kept below — review and save again.
      </Banner>,
    );
    if (review.length > 0) {
      parts.push(
        <div key="theirs" className="lp-rf-theirs" role="list" aria-label="Their changes">
          {review.map((c) => (
            <div key={c.key} className="lp-rf-their" role="listitem">
              <span className="lp-rf-their-k">{c.label}</span>
              <span className="lp-rf-their-v" data-empty={c.value === null ? '' : undefined}>
                {c.value ?? '—'}
              </span>
              {c.overlaps ? (
                <span style={{ color: 'var(--amber-11)', display: 'flex', alignSelf: 'center' }} role="img" aria-label="You changed this too">
                  <CircleAlert size={14} strokeWidth={1.75} aria-hidden />
                </span>
              ) : null}
            </div>
          ))}
        </div>,
      );
    }
  } else if (movedOn) {
    parts.push(
      <Banner key="moved" tone="amber" icon="conflict" action={{ label: 'Review', onClick: onReview }}>
        Updated by someone else
      </Banner>,
    );
  }
  if (failure) {
    parts.push(
      <Banner key="failure" tone="red" icon="error">
        {failure}
      </Banner>,
    );
  }
  return parts.length > 0 ? <div style={{ display: 'grid', gap: 6 }}>{parts}</div> : null;
}

// ---------------------------------------------------------------------------------------------------
// Needs-attention editor (A33, A39)
// ---------------------------------------------------------------------------------------------------

function OutboxEditor({ mutationId }: { mutationId: string }) {
  const selector = useCallback((s: StoreState) => s.outbox.find((o) => o.mutationId === mutationId) ?? null, [mutationId]);
  const item = useStoreSelector(selector);
  const hydrated = useStoreSelector(selectHydrated);
  // The job was shown once: if it then leaves the outbox (sent, discarded here or in another tab), close.
  const [seen, setSeen] = useState(false);
  if (item && !seen) setSeen(true);
  const leaving = useRef(false);
  const leave = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    goBack({});
  }, []);
  useEffect(() => {
    if (seen && !item) leave();
  }, [seen, item, leave]);

  if (!item) {
    return (
      <FormFrame title="Not sent">
        {hydrated && !seen ? <EmptyState icon="search" title="Request not found" action={{ label: 'Back', onClick: leave }} /> : null}
      </FormFrame>
    );
  }
  return <OutboxForm item={item} onLeave={leave} />;
}

function OutboxForm({ item, onLeave }: { item: OutboxItem; onLeave: () => void }) {
  const { actions } = useAppStore();
  const id = item.mutationId;
  // What the server rejected: errors show on fields until they are edited.
  const [rejected] = useState(() => formValuesFromCreateBody(item.payload));
  const [values, setValues] = useState(rejected);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const inFlight = useRef(false);
  const photos = useMemo<DraftPhoto[]>(
    () => item.photos.map((p) => ({ photoId: p.photoId, blob: p.blob, thumbBlob: p.thumbBlob, width: 0, height: 0 })),
    [item.photos],
  );
  const timing: PhotoTiming = item.photos[0]?.timing ?? 'today';
  const needsAttention = item.state === 'needs_attention';
  const duplicateOf = useDuplicate(values.name, { clientMutationId: id });

  const serverErrors = item.lastError && needsAttention ? formErrorsFromField(item.lastError.field, item.lastError.message) : {};
  const errors = visibleErrors(serverErrors, values, rejected);
  const unplaced = needsAttention && item.lastError && Object.keys(serverErrors).length === 0 ? item.lastError.message : null;

  const submit = async () => {
    if (inFlight.current) return;
    if (!needsAttention) {
      actions.outbox.retry(id);
      onLeave();
      return;
    }
    if (!canSend(values, photos.length)) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await actions.outbox.update(id, toCreateBody(values, id));
      actions.outbox.resend(id);
      onLeave();
    } catch {
      inFlight.current = false;
      setBusy(false);
      setFailure("Couldn't save on this phone — try again");
    }
  };

  const discard = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await actions.outbox.discard(id);
      onLeave();
    } catch {
      inFlight.current = false;
      setBusy(false);
      setFailure("Couldn't discard — try again");
    }
  };

  const message = failure ?? unplaced;
  const notice = message ? (
    <Banner tone="red" icon="error">
      {message}
    </Banner>
  ) : null;

  return (
    <>
      <RequestForm
        mode="outbox"
        section="all"
        values={values}
        onChange={setValues}
        photos={photos}
        onPhotosChange={noop}
        photoTiming={timing}
        onPhotoTimingChange={noop}
        offline={false}
        busy={busy}
        notice={notice}
        errors={errors}
        duplicateOf={duplicateOf}
        submitLabel={needsAttention ? 'Resend' : 'Send now'}
        submitDisabled={needsAttention ? !canSend(values, photos.length) || Object.keys(errors).length > 0 : item.state === 'sending'}
        onSubmit={() => void submit()}
        onCancel={() => (toPatch(rejected, values) ? setConfirmLeave(true) : onLeave())}
        onDiscard={needsAttention ? () => setConfirmDiscard(true) : undefined}
        readOnly={!needsAttention}
      />
      <Confirm
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard this request?"
        keepLabel="Keep"
        confirmLabel="Discard"
        onConfirm={() => void discard()}
      />
      {/* Leaving keeps the job as it was; only the edits made here are dropped. */}
      <Confirm
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title="Discard changes?"
        keepLabel="Keep editing"
        confirmLabel="Discard"
        onConfirm={onLeave}
      />
    </>
  );
}
