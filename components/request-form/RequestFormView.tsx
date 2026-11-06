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
import { AlertDialog, Button, Flex, Heading } from '@radix-ui/themes';
import { CircleAlert } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Banner } from '@/components/ui/Banner';
import { EmptyState } from '@/components/ui/EmptyState';
import { goBack, navigate } from '@/lib/client/nav';
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
  type AppStore,
  type CreateResult,
  type DraftPhoto,
  type MutationResult,
  type RequestDraft,
  type StoreState,
  type ToastItem,
} from '@/lib/client/store-contract';
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { isPostValue, isUuid, postFull, type EditSection, type PhotoTiming } from '@/lib/domain';
import { formatCaseNumber } from '@/lib/format';
import {
  canSaveEdit,
  createOutcomeToast,
  findDuplicate,
  newUuid,
  rebaseOnConflict,
  sameDuplicate,
  visibleErrors,
  type DuplicateRef,
  type TheirChange,
} from './form-logic';
import { RequestForm } from './RequestForm';
import './request-form.css';

export type RequestFormViewProps =
  | { mode: 'new' }
  | { mode: 'edit'; id: string; section: EditSection }
  | { mode: 'outbox'; mutationId: string };

export function RequestFormView(props: RequestFormViewProps) {
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

/** Shows a toast unless the same one is already up (the store may announce a create outcome itself). */
function showToastOnce(store: AppStore, toast: Omit<ToastItem, 'id'>): void {
  if (store.getState().toasts.some((t) => t.title === toast.title)) return;
  store.actions.showToast(toast);
}

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
            <Button variant="soft" color="gray" size="3">
              {keepLabel}
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action>
            <Button color="red" size="3" onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

/** The full-screen frame without a form: while loading, or when the request / job is gone. */
function FormFrame({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="lp-rf" data-testid="request-form">
      <header className="lp-rf-nav">
        <Button type="button" variant="ghost" color="gray" size="2" onClick={() => goBack({})}>
          Cancel
        </Button>
        <Heading as="h1" size="3" weight="medium" className="lp-rf-title">
          {title}
        </Heading>
        <span aria-hidden />
      </header>
      <div className="lp-rf-scroll" style={{ display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </div>
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

  if (!form) return <FormFrame title="New request" />;

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
    const toast = createOutcomeToast(result);
    if (toast) showToastOnce(store, toast);
    // A definitive rejection stays in the outbox: show it in the needs-attention editor, error pointed at.
    if (result.outcome === 'needs_attention') navigate({ outbox: result.mutationId }, { replace: true });
    else goBack({});
  };

  const cancel = () => {
    if (hasAnyDetail(form.values, form.photos.length)) setConfirmCancel(true);
    else void clearDraft().then(() => goBack({}));
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
        onPostPicked={(choice) => actions.setPref('lastPost', { reportingLocation: choice.reportingLocation, otherLocation: choice.otherLocation })}
      />
      <Confirm
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Discard this request?"
        keepLabel="Keep"
        confirmLabel="Discard"
        onConfirm={() => void clearDraft().then(() => goBack({}))}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------
// Edit (A10, A24)
// ---------------------------------------------------------------------------------------------------

function EditRequest({ id, section }: { id: string; section: EditSection }) {
  const row = useRequest(id);
  const loading = useIsLoading();
  if (!row) {
    return (
      <FormFrame title="Edit details">
        {loading ? null : <EmptyState icon="search" title="Request not found" action={{ label: 'Back', onClick: () => goBack({}) }} />}
      </FormFrame>
    );
  }
  return <EditForm id={id} section={section} row={row} />;
}

/** A post value the form can't express (legacy 'FA 3', …), shown as it is until another post is picked. */
function legacyPostOf(row: RequestSummary): string | null {
  return row.reportingLocation && !isPostValue(row.reportingLocation) ? postFull(row.reportingLocation, row.otherLocation) : null;
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
  // Remounts the form after a review so "More details" opens when the latest data needs it.
  const [revision, setRevision] = useState(0);
  const inFlight = useRef(false);

  const close = () => goBack({ r: id });

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
    let result: MutationResult;
    try {
      result = await actions.updateFields(id, patch, form.baseVersion);
    } catch {
      result = { ok: false, reason: 'failed', message: "Couldn't save — check signal and try again" };
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
        if (latest && latest.rowVersion !== form.baseVersion) startReview(latest);
        else setReview([]);
        return;
      }
      case 'failed':
      case 'offline':
      case 'unauthorized':
        // The store already says so (toast / sign-in); the edits stay in the form.
        return;
      default:
        setFailure(result.message);
    }
  };

  const changed = toPatch(form.base, form.values) !== null;
  const cancel = () => {
    if (changed) setConfirmCancel(true);
    else close();
  };

  // Someone else saved while this was open (and no 409 review is showing yet).
  const movedOn = row.rowVersion !== form.baseVersion && !busy;

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
