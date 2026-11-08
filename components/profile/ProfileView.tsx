'use client';
// Request profile (?r=<id>, spec §8 Profile; design/screens/profile.html + states.html "Photo"). Renders
// immediately from the synced summary (or from the detail when a deep link arrives before the row has
// synced); photos and the audit trail come from useDetail(id), which refetches whenever the synced
// rowVersion changes, and show skeletons until it loads.
//
//   top bar      × · LP number · ⋯ (Edit details, Mark discharged while In medical, Reopen when Reunited /
//                Discharged / Cancelled — Cancelled → Waiting creator-only —, Cancel request creator-only
//                while Waiting). Not in medical is closed and grey since v2.2 but keeps its own actions:
//                Change answer only, never Reopen (domain primaryActions / menuActions go by status).
//   header       portrait + photo count, name, age · gender, post · who logged it
//   status block status colour (grey for every closed status, Not in medical included); wait badge while
//                Waiting; while In medical only "Rae Chen · 11:10 AM" (who answered, when), then where medical
//                has them: a pin, "Chair 14" and a pencil, or "+ Location" (Pending v8, 2026-11-06 afternoon;
//                the location editor is a sheet on the phone, a popover in the desk pane); who and when for
//                the other answers. (2026-11-08) On hold: "Pending · not located yet" / "Recheck due · not located
//                yet", "First check · Rae C. · 12:52", and "Medical rechecks 1:12 AM · in 14 min" over a bar
//                that fills over the 20 minutes ("Medical recheck was due 1:12 AM · 3 min ago" once due)
//   preview      (R1, Brian 2026-11-07) the latest message, only while the request needs info or has unread
//                messages for me; a tap brings the thread into view (CardActivity ThreadPreview). (2026-11-08) Two
//                lines and its time; no second Needs info chip on it (the status block says Needs info)
//   details      Missing person / Friend or family, filled fields only, each with Edit; Phone has Call
//   photos       tiles → full-screen viewer; Add tile (needs a connection) until there are 3
//   messages     (F3; R1: below the details and photos, like Linear / Zendesk / GitHub issues) the thread
//   audit trail  newest first (audit-trail.ts)
//   actions      sticky, by status; disabled offline with "Needs a connection". Change answer (In medical,
//                Not in medical) opens a menu: the other answer and Back to Waiting for check
//                (change-answer.ts). Every answer, change and Reunited offers Undo (the store's snackbar).
//                (F6) Closed · inactive offers Reopen there instead (back to In medical, no Undo, like every Reopen).
//                In the desk pane (presentation="panel", design/screens/desktop-log.html) they sit right under
//                the status block, two equal buttons, and the menu opens downwards.
//   cancel       red, creator-only (canonical created_by match, A18), while Waiting, confirm Keep / Cancel
//   conflict     "Updated by someone else" when another person's change arrives while it is open
import { AlertDialog, Badge, Button, DropdownMenu, Heading, IconButton, Skeleton, Text, VisuallyHidden } from '@radix-ui/themes';
import { Camera, Check, ChevronDown, Clock, CloudOff, Ellipsis, History, Hourglass, MapPin, Pencil, Phone, Plus, RotateCcw, Trash2, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { CropSheet } from '@/components/photo/CropSheet';
import { useCropQueue, type CropPick } from '@/components/photo/use-crop-queue';
import { StatusEnroute } from '@/components/messages/Enroute';
import { MessagesSection } from '@/components/messages/MessagesSection';
import { ThreadPreview } from '@/components/messages/CardActivity';
import { Banner, ConnectionBanner } from '@/components/ui/Banner';
import { EmptyState } from '@/components/ui/EmptyState';
import { ProfileSkeleton } from '@/components/ui/Skeleton';
import { StageGlyph } from '@/components/ui/StageGlyph';
import { StatusGlyph, SwapGlyph } from '@/components/ui/StatusGlyph';
import type { RequestDetail, RequestSummary } from '@/lib/api-types';
import { useThreadLoaded } from '@/lib/client/messages-hooks';
import { goBack, navigate } from '@/lib/client/nav';
import { takeThreadParam } from '@/lib/client/thread-jump';
import {
  useActions,
  useConnection,
  useDetail,
  useEventTimezone,
  useIsLoading,
  useNow,
  useRequest,
  useSession,
  useStoreSelector,
  type MutationResult,
  type StoreState,
} from '@/lib/client/store-contract';
import { FIELD_LABELS, MAX_PHOTOS, PHOTO_TIMING_LABEL, STATUS, canCancel, isHeld, isInMedical, isStatus, menuActions, parseStaff, postFull, primaryActions, sameStaff, statusMeta, telHref, waitTone, type PhotoTiming, type SettableStatus, type StatusAction, type StatusKind } from '@/lib/domain';
import { displayStage, holdAnsweredAt, isMedicalTeam, notFoundAnswer, recheckCountdown, shortStaffName } from '@/lib/stages';
import { formatCaseNumber, formatCreatedTime, formatDuration, formatListTime, minutesSince } from '@/lib/format';
import { threadPreviewShown, unreadOf } from '@/lib/messaging';
import { AddPhotosSheet, type PhotoPick } from './AddPhotos';
import { AuditTrail, AuditTrailSkeleton } from './AuditTrail';
import { buildAuditTrail, holdOrigin, statusOrigin, type StatusOrigin } from './audit-trail';
import { Bust } from './Bust';
import { primeKeyboard } from '@/components/list/hooks';
import { changeAnswerChoices } from './change-answer';
import { LocationEditor } from './LocationEditor';
import { CompanionComingRow, FriendMayBeRow, LocatedSheet, SwapSheet } from './CompanionSheets';
import { FRIEND_INFORMED_LABEL, REQUEST_SWAP_LABEL, SWAP_DONE_LABEL, SWAP_REQUESTED_LABEL, isSwapApproved, isSwapRequested } from '@/lib/client/swap';
import { PhotoViewer, photoUrl } from './PhotoViewer';
import s from './profile.module.css';

export interface ProfileViewProps {
  /** Request id from ?r=. */
  id: string;
  /**
   * "panel": inside the desk detail pane (components/desk), which supplies the top bar (LP number, ⋯,
   * close) and scrolls itself, so the profile hides its own top bar and leaves the window scroll alone.
   */
  presentation?: 'page' | 'panel';
}

const HIDDEN = { display: 'none' } as const;

/** How long the "Updated by someone else" banner stays up. */
const CONFLICT_BANNER_MS = 8_000;
const NEEDS_CONNECTION = 'Needs a connection';
const NO_NAME = 'Name not provided';

const close = () => goBack({});
/** (R1) The store has synced since this page loaded: its rows are no longer only the phone's cache. */
const selectSynced = (s: StoreState) => s.lastSyncLocalAt !== null;
const nameOf = (row: RequestSummary) => row.name.trim() || NO_NAME;

export function ProfileView({ id, presentation = 'page' }: ProfileViewProps) {
  const panel = presentation === 'panel';
  const storeRow = useRequest(id);
  const { detail, loading: detailLoading, error: detailError, refresh } = useDetail(id);
  const storeLoading = useIsLoading();
  // A deep link can arrive before the row has synced: the detail is a full RequestSummary too.
  const row: RequestSummary | null = storeRow ?? detail;

  // Views share one document: start a profile at the top, not at the list's scroll position.
  useEffect(() => {
    if (!panel) window.scrollTo(0, 0);
  }, [id, panel]);
  // (R2) "/?r=<id>&to=thread" (a message's notification): land at the thread once it shows.
  useEffect(() => {
    takeThreadParam(id);
  }, [id]);

  if (!row) {
    const settled = !storeLoading && !detailLoading;
    if (settled && detailError === 'not_found') {
      return (
        <Frame panel={panel}>
          <EmptyState icon="search" title="Request not found" action={{ label: 'Back', onClick: close }} />
        </Frame>
      );
    }
    if (settled && detailError && detailError !== 'unauthorized') {
      return (
        <Frame panel={panel}>
          <EmptyState icon="plug" title="Can't reach the log" action={{ label: 'Try again', onClick: refresh, icon: 'refresh' }} />
        </Frame>
      );
    }
    return (
      <Frame panel={panel}>
        <ProfileSkeleton chrome={false} />
      </Frame>
    );
  }
  return (
    <Profile
      key={id}
      row={row}
      detail={detail}
      detailLoading={detailLoading}
      detailFailed={!detail && !detailLoading && detailError !== null}
      refresh={refresh}
      panel={panel}
    />
  );
}

/** The bare top bar (× only) around the loading / not-found states. */
function Frame({ children, panel }: { children: ReactNode; panel: boolean }) {
  return (
    <div className={s.app} data-testid="profile" data-presentation={panel ? 'panel' : undefined}>
      <div className={s.nav} style={panel ? HIDDEN : undefined}>
        <CloseButton />
        <span />
        <span />
      </div>
      {children}
    </div>
  );
}

function CloseButton() {
  return (
    <IconButton variant="soft" color="gray" radius="full" aria-label="Close" className={s.hit} onClick={close}>
      <X size={16} aria-hidden />
    </IconButton>
  );
}

interface ProfileProps {
  row: RequestSummary;
  detail: RequestDetail | null;
  detailLoading: boolean;
  detailFailed: boolean;
  refresh: () => void;
  panel: boolean;
}

type AddState = { picks: PhotoPick[]; unreadable: number; phase: 'preparing' | 'ready' | 'uploading'; error: string | null };
type CancelState = { busy: boolean; error: string | null };

function Profile({ row, detail, detailLoading, detailFailed, refresh, panel }: ProfileProps) {
  const actions = useActions();
  const session = useSession();
  const { connection } = useConnection();
  const timeZone = useEventTimezone();
  const now = useNow();
  const offline = connection === 'offline';
  const label = formatCaseNumber(row.caseNumber);
  const isCreator = sameStaff(row.createdBy, session.staff);
  const cancellable = canCancel(row.status, row.createdBy, session.staff);

  const trail = useMemo(() => (detail ? buildAuditTrail(detail.audit, timeZone) : null), [detail, timeZone]);
  // (F5) A request on a "Not found yet" hold shows who gave that first Not found.
  const held = isHeld(row);
  const origin = useMemo(
    () => (detail ? (held ? holdOrigin(detail.audit) : statusOrigin(detail.audit, row.status)) : null),
    [detail, row.status, held],
  );

  // --- Someone else changed it while it was open ------------------------------------------------------
  const [seenVersion, setSeenVersion] = useState(row.rowVersion);
  const conflict = row.rowVersion > seenVersion && !sameStaff(row.updatedBy, session.staff);
  useEffect(() => {
    if (!conflict) return;
    const timer = setTimeout(() => setSeenVersion(row.rowVersion), CONFLICT_BANNER_MS);
    return () => clearTimeout(timer);
  }, [conflict, row.rowVersion]);

  // --- (R1) The latest-message line: while it needs info, or once unread messages for me came in ------------
  // The thread marks itself read as soon as it loads (MessagesSection), so the page keeps what it saw: unread
  // messages on arrival or while it was open (state adjusted during render, React's pattern). Only a count this
  // visit heard from the server is kept: a sync since the page loaded, the request's detail, or its thread (each
  // writes the row before the thread can mark it read). The phone's cache read at start can be behind (read on
  // another device, or just before a reload) and would keep a dot for a message already read.
  const synced = useStoreSelector(selectSynced);
  const threadLoaded = useThreadLoaded(row.id);
  const unread = unreadOf(row) > 0 && (synced || detail !== null || threadLoaded);
  const [seenUnread, setSeenUnread] = useState(unread);
  if (unread && !seenUnread) setSeenUnread(true);
  const shownStage = displayStage(row, { now, timeZone });
  const needsInfo = shownStage.key === 'needsInfo' ? shownStage : null;
  const preview = threadPreviewShown(needsInfo !== null, seenUnread, row.lastMessage) ? (
    // (2026-11-08, T1) No chip on the line: the status block above it already says Needs info, in words and glyph.
    <ThreadPreview row={row} needsInfo={null} unread={seenUnread && !row.lastMessage?.mine} />
  ) : null;

  // --- Retry the detail when the connection comes back --------------------------------------------------
  const lastConnection = useRef(connection);
  useEffect(() => {
    const was = lastConnection.current;
    lastConnection.current = connection;
    if (was !== 'live' && connection === 'live' && detailFailed) refresh();
  }, [connection, detailFailed, refresh]);

  // --- Photos: viewer and Add ----------------------------------------------------------------------------
  const photos = detail?.photos ?? [];
  const photoCount = Math.max(row.photoCount, photos.length);
  const [viewerAt, setViewerAt] = useState<number | null>(null);
  const [add, setAdd] = useState<AddState | null>(null);
  const addRun = useRef(0);
  // The open add run (the Add sheet): its prepared picks, its unreadable count, how many files were handed
  // to it (prepared, still preparing or unreadable), and how many preparations are in flight. Refs, so a
  // second hand-over while the first is still preparing appends to it.
  const livePicks = useRef<PhotoPick[]>([]);
  const runOpen = useRef(false);
  const runFiles = useRef(0);
  const runUnreadable = useRef(0);
  const runPreparing = useRef(0);
  useEffect(() => {
    const picks = livePicks;
    return () => revoke(picks.current);
  }, []);

  const closeAdd = useCallback(() => {
    addRun.current += 1;
    revoke(livePicks.current);
    livePicks.current = [];
    runOpen.current = false;
    runFiles.current = 0;
    runUnreadable.current = 0;
    runPreparing.current = 0;
    setAdd(null);
  }, []);

  // Each picked photo goes through the quick-crop step first (CropSheet, v2.2 #10), then is prepared. Photos
  // handed over while an add run is open (a Retake's photo that came in after the others were handed over)
  // join that run: nothing it already holds is revoked or replaced (F2 review).
  const fileInput = useRef<HTMLInputElement | null>(null);
  const prepareCropped = async (cropped: CropPick[]) => {
    if (!runOpen.current) {
      addRun.current += 1;
      runOpen.current = true;
    }
    const run = addRun.current;
    runFiles.current += cropped.length;
    runPreparing.current += 1;
    setAdd({ picks: livePicks.current, unreadable: runUnreadable.current, phase: 'preparing', error: null });
    // One at a time: decoding several camera photos at once can exhaust iOS memory.
    for (const { file, crop: cropRect } of cropped) {
      try {
        const photo = await actions.preparePhoto(file, { crop: cropRect });
        if (addRun.current !== run) return;
        livePicks.current = [...livePicks.current, { photo, url: URL.createObjectURL(photo.thumbBlob) }];
      } catch {
        if (addRun.current !== run) return;
        runUnreadable.current += 1;
      }
    }
    if (addRun.current !== run) return;
    runPreparing.current -= 1;
    setAdd({ picks: livePicks.current, unreadable: runUnreadable.current, phase: runPreparing.current > 0 ? 'preparing' : 'ready', error: null });
  };
  const crop = useCropQueue((picks) => void prepareCropped(picks), fileInput);

  const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    const inRun = runOpen.current ? runFiles.current - runUnreadable.current : 0;
    const room = MAX_PHOTOS - photoCount - crop.pending() - inRun;
    if (files.length === 0 || room <= 0) return;
    crop.enqueue(files.slice(0, room));
  };

  const onAdd = async (timing: PhotoTiming) => {
    if (!add || add.picks.length === 0) return;
    const run = addRun.current;
    const picks = add.picks;
    setAdd({ ...add, phase: 'uploading', error: null });
    let failed = picks.length;
    try {
      ({ failed } = await actions.addPhotos(row.id, picks.map((p) => p.photo), timing, { quiet: true }));
    } catch {
      // Treated as every photo failing; a retry resends the same photo ids.
    }
    if (addRun.current !== run) return;
    if (failed === 0) {
      closeAdd();
      return;
    }
    setAdd({
      picks,
      unreadable: 0,
      phase: 'ready',
      error: failed >= picks.length ? "Couldn't upload — check signal and try again" : `${failed} of ${picks.length} didn't upload — try again`,
    });
  };

  // --- Cancel ------------------------------------------------------------------------------------------
  const [cancelState, setCancelState] = useState<CancelState | null>(null);
  // The dialog closes for good if the request stops being cancellable while it is open (someone answered
  // it), unless a cancel is in flight or its error is showing. (State adjusted during render, React's
  // pattern for state that follows props.)
  if (cancelState && !cancellable && !cancelState.busy && cancelState.error === null) setCancelState(null);
  const confirmOpen = cancelState !== null;
  const openCancel = () => setCancelState({ busy: false, error: null });
  const doCancel = async () => {
    if (offline) {
      setCancelState({ busy: false, error: NEEDS_CONNECTION });
      return;
    }
    setCancelState({ busy: true, error: null });
    let result: MutationResult;
    try {
      result = await actions.cancel(row.id, { quiet: true });
    } catch {
      result = { ok: false, reason: 'failed', message: '' };
    }
    if (result.ok) setCancelState(null);
    else setCancelState({ busy: false, error: failureMessage(result) });
  };

  // The store owns the optimistic overlay, the Undo bar (answer, change, reunite) and every failure toast.
  const send = (to: SettableStatus, kind: StatusKind) => void actions.setStatus(row.id, to, kind);
  // (Companion) Located from Waiting / Not located asks "Someone already with them?" first; nothing saves until
  // one of its two answers is tapped.
  const [locatedKind, setLocatedKind] = useState<StatusKind | null>(null);
  const move = (to: SettableStatus, kind: StatusKind) => {
    if (to === STATUS.inMedical && (row.status === STATUS.waiting || row.status === STATUS.notInMedical) && kind !== 'undo') {
      setLocatedKind(kind);
      return;
    }
    send(to, kind);
  };
  const setStatus = (a: StatusAction) => move(a.to, a.kind);
  const menu = menuActions(row.status, isCreator);
  // (Companion) The swap decision sheet: opens by itself for anyone but the person who asked, once per request.
  const swapRequested = isSwapRequested(row);
  const swapApproved = isSwapApproved(row);
  const [swapOpen, setSwapOpen] = useState(false);
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!swapRequested) {
      setSwapOpen(false);
      return;
    }
    const key = `${row.id}:${row.swapRequestedAt ?? ''}`;
    if (autoOpened.current === key || sameStaff(row.swapRequestedBy ?? '', session.staff)) return;
    autoOpened.current = key;
    setSwapOpen(true);
  }, [swapRequested, row.id, row.swapRequestedAt, row.swapRequestedBy, session.staff]);
  const swap = (a: Parameters<typeof actions.swap>[1]) => {
    setSwapOpen(false);
    void actions.swap(row.id, a);
  };
  // (F5) Medical side, Waiting for check (held or not): the two answers sit inside the status block
  // (design/screens/clarify-7.png, recheck-3.png); front of house keeps them in the bar as before.
  const answersInBlock = isMedicalTeam(session.team) && row.status === STATUS.waiting;
  const footer = answersInBlock ? [] : primaryActions(row.status);
  // (Companion) Accompanied: Request swap | Friend informed; swap requested: the decision; swap approved: Swap done.
  const companionFooter: ReactNode =
    row.status === STATUS.accompanied ? (
      swapRequested ? (
        <Button size="3" variant="soft" color="blue" className="lp-hit" disabled={offline} onClick={() => setSwapOpen(true)} data-testid="swap-decide">
          <SwapGlyph tone="blue" size={15} />
          {SWAP_REQUESTED_LABEL}
        </Button>
      ) : (
        <>
          <Button size="3" variant="soft" color="gray" className="lp-hit" disabled={offline} onClick={() => swap({ action: 'request' })} data-testid="request-swap">
            <SwapGlyph tone="gray" size={15} />
            {REQUEST_SWAP_LABEL}
          </Button>
          <Button size="3" highContrast className="lp-hit" disabled={offline} onClick={() => send(STATUS.friendInformed, 'reunite')} data-testid="friend-informed">
            <Check size={16} aria-hidden />
            {FRIEND_INFORMED_LABEL}
          </Button>
        </>
      )
    ) : swapApproved ? (
      <Button size="3" highContrast className="lp-hit" disabled={offline} onClick={() => send(STATUS.reunited, 'reunite')} data-testid="swap-done">
        <Check size={16} aria-hidden />
        {SWAP_DONE_LABEL}
      </Button>
    ) : null;
  const companionCount = row.status === STATUS.accompanied && !swapRequested ? 2 : companionFooter ? 1 : 0;
  // The phone's sticky bar at the foot of the screen; the desk pane's row under the status block.
  const actionBar = companionFooter ? (
    <div
      className={panel ? s.acts : s.foot}
      data-layout={companionCount === 1 ? 'one' : 'two'}
      data-sticky-foot={panel ? undefined : ''}
      data-testid="profile-actions"
    >
      {offline ? (
        <span className={s.offline}>
          <CloudOff size={13} aria-hidden />
          {NEEDS_CONNECTION}
        </span>
      ) : null}
      {companionFooter}
    </div>
  ) :
    footer.length > 0 ? (
      <div
        className={panel ? s.acts : s.foot}
        data-layout={footer.length === 1 ? 'one' : panel ? 'two' : isInMedical(row.status) ? 'one-two' : 'two'}
        // (R2) The phone's bar covers the foot of the screen: a jump to the thread keeps the composer above it.
        data-sticky-foot={panel ? undefined : ''}
        data-testid="profile-actions"
      >
        {offline ? (
          <span className={s.offline}>
            <CloudOff size={13} aria-hidden />
            {NEEDS_CONNECTION}
          </span>
        ) : null}
        {footer.map((a) =>
          a.kind === 'change' ? (
            // Keyed by status: an open menu closes when the status moves under it (someone else's answer),
            // so a tap never lands on a choice that changed meaning.
            <ChangeAnswerMenu key={`${a.id}:${row.status}`} status={row.status} disabled={offline} side={panel ? 'bottom' : 'top'} onChoose={move} />
          ) : (
            <ActionButton key={a.id} action={a} row={row} disabled={offline} onClick={() => setStatus(a)} />
          ),
        )}
      </div>
    ) : null;

  return (
    <div className={s.app} data-testid="profile" data-status={row.status} data-presentation={panel ? 'panel' : undefined}>
      <div className={s.nav} style={panel ? HIDDEN : undefined}>
        <CloseButton />
        <Text size="2" weight="medium" color="gray" data-testid="profile-case">
          {label}
        </Text>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <IconButton variant="soft" color="gray" radius="full" aria-label="More actions" className={s.hit}>
              <Ellipsis size={16} aria-hidden />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" variant="soft" className={s.pmenu}>
            <DropdownMenu.Item onSelect={() => navigate({ r: row.id, edit: 'all' })}>
              <Pencil size={15} aria-hidden />
              Edit details
            </DropdownMenu.Item>
            {row.status === STATUS.accompanied ? (
              <>
                {changeAnswerChoices(row.status).map((c) => (
                  <DropdownMenu.Item key={c.to} disabled={offline} onSelect={() => send(c.to, c.kind)} data-to={c.to}>
                    <StatusGlyph status={c.to} size={15} />
                    {c.label}
                  </DropdownMenu.Item>
                ))}
                <DropdownMenu.Item disabled={offline} onSelect={() => send(STATUS.discharged, 'discharge')}>
                  <Check size={15} aria-hidden />
                  Mark discharged
                </DropdownMenu.Item>
              </>
            ) : null}
            {row.status === STATUS.friendInformed ? (
              <DropdownMenu.Item disabled={offline} onSelect={() => send(STATUS.accompanied, 'reopen')}>
                <RotateCcw size={15} aria-hidden />
                Reopen
              </DropdownMenu.Item>
            ) : null}
            {menu.map((a) => (
              <DropdownMenu.Item key={a.id} disabled={offline} onSelect={() => setStatus(a)}>
                {a.id === 'discharge' ? <Check size={15} aria-hidden /> : <RotateCcw size={15} aria-hidden />}
                {a.label}
              </DropdownMenu.Item>
            ))}
            {cancellable ? (
              <>
                <DropdownMenu.Separator />
                <DropdownMenu.Item color="red" onSelect={openCancel}>
                  <Trash2 size={15} aria-hidden />
                  Cancel request
                </DropdownMenu.Item>
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
      <ConnectionBanner />
      {conflict ? (
        <div className={s.banner}>
          <Banner tone="amber" icon="conflict">
            Updated by someone else
          </Banner>
        </div>
      ) : null}

      <main className={s.body}>
        <div className={s.hero}>
          <Portrait row={row} photoCount={photoCount} canOpen={photos.length > 0} onOpen={() => setViewerAt(0)} />
          <div className={s.hn}>
            <Heading as="h1" size="5" weight="medium" color={row.name ? undefined : 'gray'}>
              {row.name || NO_NAME}
            </Heading>
            {ageGenderLong(row) ? (
              <Text size="3" color="gray">
                {ageGenderLong(row)}
              </Text>
            ) : null}
            <span className={s.meta}>
              {[postFull(row.reportingLocation, row.otherLocation), parseStaff(row.createdBy).name].filter(Boolean).join(' · ')}
            </span>
          </div>
        </div>

        <StatusBlock
          row={row}
          origin={origin}
          originLoading={!detail && detailLoading}
          now={now}
          timeZone={timeZone}
          offline={offline}
          panel={panel}
          onNeedsConnection={() => actions.showToast({ tone: 'amber', icon: 'cloud-off', title: NEEDS_CONNECTION, durationMs: 3_000 })}
          answers={answersInBlock ? <BlockAnswers row={row} offline={offline} onAnswer={setStatus} /> : null}
          enrouteSlot={swapApproved && row.swapPlace === 'fa' ? <CompanionComingRow row={row} /> : <StatusEnroute row={row} />}
        />

        <FriendMayBeRow row={row} />

        <LocatedSheet
          row={locatedKind ? row : null}
          open={locatedKind !== null}
          offline={offline}
          onClose={() => setLocatedKind(null)}
          onChoose={(to) => {
            const kind = locatedKind ?? 'answer';
            setLocatedKind(null);
            send(to, kind);
          }}
        />
        <SwapSheet
          row={swapRequested ? row : null}
          open={swapOpen && swapRequested}
          offline={offline}
          sub={swapSub(row, now, timeZone)}
          onClose={() => setSwapOpen(false)}
          onApprove={(place) => swap({ action: 'approve', place })}
          onDecline={() => swap({ action: 'decline' })}
        />

        {panel ? actionBar : null}

        {preview}

        <Details row={row} />

        <SectionLabel>Photos</SectionLabel>
        {detailFailed ? (
          <Banner tone="gray" icon="error" action={{ label: 'Try again', onClick: refresh }}>
            Can&apos;t load photos and audit trail
          </Banner>
        ) : null}
        <div className={s.photos}>
          {detail
            ? photos.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  className={s.ph}
                  aria-label={`Photo ${i + 1} of ${photos.length}, ${PHOTO_TIMING_LABEL[p.timing] ?? PHOTO_TIMING_LABEL.unsure}`}
                  onClick={() => setViewerAt(i)}
                >
                  <Thumb id={p.id} size={70} />
                </button>
              ))
            : detailFailed
              ? null
              : Array.from({ length: photoCount }, (_, i) => <Skeleton key={i} width="78px" height="78px" style={{ borderRadius: 'var(--radius-3)' }} />)}
          {photoCount < MAX_PHOTOS ? (
            <label className={`${s.ph} ${s.add}`} aria-disabled={offline} data-testid="add-photo">
              <Camera size={20} aria-hidden />
              <span>Add</span>
              <VisuallyHidden>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  multiple
                  // Never while a Retake's picker is open (its photo must arrive); else not offline or while
                  // the add run uploads (a photo picked then joins the open run).
                  disabled={!crop.retaking && (offline || add?.phase === 'uploading')}
                  aria-label={offline ? `Add photo (${NEEDS_CONNECTION.toLowerCase()})` : 'Add photo'}
                  onChange={onFiles}
                />
              </VisuallyHidden>
            </label>
          ) : null}
        </div>

        {/* F3: the request's thread, at every status (updates.html v7); R1: after the details and photos. */}
        <MessagesSection row={row} panel={panel} />

        {detailFailed ? null : (
          <>
            <SectionLabel>Audit trail</SectionLabel>
            {trail ? <AuditTrail items={trail} /> : <AuditTrailSkeleton />}
          </>
        )}

        {cancellable ? (
          <button type="button" className={s.danger} onClick={openCancel}>
            <Trash2 size={16} aria-hidden />
            Cancel request
          </button>
        ) : null}
      </main>

      {panel ? null : actionBar}

      <AlertDialog.Root
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open && !cancelState?.busy) setCancelState(null);
        }}
      >
        <AlertDialog.Content maxWidth="342px" className={s.dialog} style={{ padding: 20 }}>
          <AlertDialog.Title size="4" weight="medium" mb="1">
            Cancel this request?
          </AlertDialog.Title>
          <AlertDialog.Description size="2" color="gray">
            {[label, row.name].filter(Boolean).join(' · ')}
          </AlertDialog.Description>
          {cancelState?.error ? (
            <Text as="p" role="alert" className={s.error} mt="2">
              {cancelState.error}
            </Text>
          ) : null}
          <div className={s.btns}>
            <AlertDialog.Cancel>
              <Button size="3" variant="soft" color="gray" className="lp-hit" disabled={cancelState?.busy}>
                Keep
              </Button>
            </AlertDialog.Cancel>
            <Button size="3" color="red" className="lp-hit lp-solid-accent" loading={cancelState?.busy} onClick={() => void doCancel()}>
              Cancel request
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Root>

      {viewerAt !== null && photos.length > 0 ? (
        <PhotoViewer
          photos={photos}
          startIndex={viewerAt}
          personLabel={[label, row.name].filter(Boolean).join(' · ')}
          timeZone={timeZone}
          now={now}
          onClose={() => setViewerAt(null)}
        />
      ) : null}

      <CropSheet item={crop.current} position={crop.position} onUse={crop.use} onRetake={crop.retake} />

      {add ? (
        <AddPhotosSheet
          picks={add.picks}
          unreadable={add.unreadable}
          busy={add.phase !== 'ready'}
          error={add.error}
          disabled={offline}
          onAdd={(timing) => void onAdd(timing)}
          onClose={closeAdd}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------------

const revoke = (picks: readonly PhotoPick[]) => picks.forEach((p) => URL.revokeObjectURL(p.url));

/** "19 · Female" (the profile spells the gender out; lists use "19 F"). */
/** (Companion) The swap sheet's "Dana K. · 12:31 PM": who asked and when. */
function swapSub(row: RequestSummary, now: number, timeZone: string): string {
  const who = row.swapRequestedBy ? shortStaffName(parseStaff(row.swapRequestedBy).name) : '';
  const at = row.swapRequestedAt ? formatListTime(row.swapRequestedAt, now, timeZone) : '';
  return [who, at].filter(Boolean).join(' · ');
}

function ageGenderLong(row: RequestSummary): string {
  return [row.age === null ? null : String(row.age), row.gender?.trim() || null].filter(Boolean).join(' · ');
}

function failureMessage(result: Extract<MutationResult, { ok: false }>): string {
  switch (result.reason) {
    case 'offline':
      return NEEDS_CONNECTION;
    case 'forbidden':
      return 'Only the person who logged it can cancel it';
    case 'conflict':
      return 'Updated by someone else';
    case 'invalid':
      return "It's no longer waiting for check";
    case 'not_found':
      return 'Request not found';
    default:
      return result.message || "Couldn't save — check signal and try again";
  }
}

function Thumb({ id, size }: { id: string; size: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Bust size={size} />;
  return <img src={photoUrl(id, 'thumb')} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />;
}

function Portrait({ row, photoCount, canOpen, onOpen }: { row: RequestSummary; photoCount: number; canOpen: boolean; onOpen: () => void }) {
  const content = (
    <>
      {row.firstPhotoId ? <Thumb key={row.firstPhotoId} id={row.firstPhotoId} size={74} /> : <Bust size={74} />}
      {photoCount > 0 ? (
        <span className={s.cnt} aria-hidden>
          {photoCount}
        </span>
      ) : null}
    </>
  );
  const count = photoCount === 1 ? '1 photo' : `${photoCount} photos`;
  if (canOpen) {
    // Starts with the count the badge shows, "2 photos, open viewer" (WCAG 2.5.3).
    return (
      <button type="button" className={s.portrait} aria-label={`${count}, open viewer`} onClick={onOpen}>
        {content}
      </button>
    );
  }
  return (
    <div className={s.portrait} role="img" aria-label={photoCount > 0 ? count : 'No photo'}>
      {content}
    </div>
  );
}

/** Before the audit trail loads: who answered and when, from the row's own timestamps where possible. */
function fallbackOrigin(row: RequestSummary): StatusOrigin | null {
  // reunion_started_at is set on every entry into In medical; found_at only the first time (legacy
  // Bring-friend rows may have only found_at). closed_at belongs to Reunited / Discharged / Cancelled (and
  // legacy closed values) only: Not in medical is in the closed bucket since v2.2 but never sets it, so it
  // keeps waiting for the audit trail as before.
  const at = isInMedical(row.status)
    ? (row.reunionStartedAt ?? (row.status === STATUS.legacyBringFriend ? row.foundAt : null))
    : statusMeta(row.status).bucket === 'closed' && row.status !== STATUS.notInMedical
      ? row.closedAt
      : null;
  if (!at) return null;
  // updatedBy is the person behind that change only if nothing has touched the row since.
  const sameMoment = Math.abs(Date.parse(row.updatedAt) - Date.parse(at)) < 2_000;
  return { staffName: sameMoment ? parseStaff(row.updatedBy).name : '', at };
}

function StatusBlock({
  row,
  origin,
  originLoading,
  now,
  timeZone,
  offline,
  panel,
  onNeedsConnection,
  answers = null,
  enrouteSlot = null,
}: {
  row: RequestSummary;
  origin: StatusOrigin | null;
  originLoading: boolean;
  now: number;
  timeZone: string;
  offline: boolean;
  panel: boolean;
  onNeedsConnection: () => void;
  /** (F5) The medical side's answers, inside the block while Waiting for check (held or not). */
  answers?: ReactNode;
  /** (F3) The en route row goes here, under the location row. */
  enrouteSlot?: ReactNode;
}) {
  // (F5) The stage (lib/stages displayStage): Needs info, Not found yet, … over the stored status. The block
  // keeps In medical's look while a friend is en route or has arrived: F3's en route row says that under it.
  const shown = displayStage(row, { now, timeZone });
  const stage = shown.key === 'enroute' || shown.key === 'arrived' ? displayStage({ ...row, enroute: null }, { now, timeZone }) : shown;
  const waiting = stage.key === 'waiting';
  const inMedical = isInMedical(row.status);
  // (2026-11-08, Pending clarity) A hold's block says it in full: "Pending · not located yet", "First check · Rae C. ·
  // 12:52", and its row "Medical rechecks 1:12 AM · in 14 min" over a bar that fills over the 20 minutes. Screen
  // readers hear sentences ("Pending, not located yet.") instead of the dots.
  const hold = stage.key === 'notFoundYet' || stage.key === 'recheckDue';
  const countdown = stage.recheckAt ? recheckCountdown(stage.recheckAt, now, timeZone) : null;
  let sub: ReactNode = null;
  let subSaid: string | null = null;
  let badge: ReactNode = null;
  if (stage.key === 'needsInfo' && stage.sub) {
    sub = stage.sub;
  } else if (hold) {
    // Who gave the first Not found, and when; before the trail loads, the row's own last change when it is that.
    const o = origin ?? holdFallbackOrigin(row);
    if (o) {
      const who = shortStaffName(o.staffName);
      sub = ['First check', who, formatListTime(o.at, now, timeZone)].filter(Boolean).join(' · ');
      subSaid = `First check${who ? ` by ${who}` : ''} at ${formatCreatedTime(o.at, now, timeZone)}.`;
    } else if (originLoading) sub = <Skeleton height="12px" width="45%" style={{ marginTop: 2 }} />;
  } else if (row.status === STATUS.waiting) {
    sub = `Logged ${formatListTime(row.createdAt, now, timeZone)}`;
    const minutes = minutesSince(row.createdAt, now);
    const tone = waitTone(minutes);
    // Amber and red badges use step 12 text: step 11 on its own tint is under 4.5:1 (spec §7).
    badge = (
      <Badge size="2" variant="soft" color={tone} highContrast={tone !== 'gray'} data-testid="wait-badge">
        <Clock size={13} aria-hidden />
        <VisuallyHidden>Waiting </VisuallyHidden>
        {formatDuration(minutes)}
      </Badge>
    );
  } else if (isStatus(row.status)) {
    // Who answered and when, nothing else (Brian, 2026-11-06 afternoon: the "heading to Main Med" line went).
    const o = origin ?? fallbackOrigin(row);
    const parts = o ? [o.staffName, formatListTime(o.at, now, timeZone)].filter(Boolean) : [];
    if (parts.length > 0) sub = parts.join(' · ');
    else if (originLoading) sub = <Skeleton height="12px" width="45%" style={{ marginTop: 2 }} />;
  }
  return (
    <div className={s.statusBox} data-tone={stage.tone} data-stage={stage.key} data-testid="status-block">
      <div className={s.status}>
        <StageGlyph glyph={stage.glyph} size={18} />
        <div className={s.sx}>
          {/* Step 12 of the status colour on its step-3 tint: step 11 is ~4.3:1 there (spec §7). */}
          <Text size="3" weight="medium" color={stage.tone} highContrast={stage.tone !== 'gray'} aria-hidden={hold || undefined} data-testid="status-label">
            {stage.fullLabel}
          </Text>
          {hold ? <VisuallyHidden>{`${stage.fullLabel.replace(/\s*·\s*/g, ', ')}.`}</VisuallyHidden> : null}
          {sub ? (
            <Text as="div" size="1" color="gray" aria-hidden={subSaid ? true : undefined} data-testid="status-sub">
              {sub}
            </Text>
          ) : null}
          {subSaid ? <VisuallyHidden>{subSaid}</VisuallyHidden> : null}
        </div>
        {waiting ? badge : null}
      </div>
      {/* (F5) While on hold, Needs info included: the hold goes on while medical asks. Not on a card or a row
          (Pending v9.1): the request's own status block keeps when the recheck is due. (2026-11-08) With the minutes
          left at its right and a bar that fills over the hold; once due, how long ago, and no bar. */}
      {countdown ? (
        <div className={s.recheckRow} data-due={countdown.due ? '' : undefined} data-testid="recheck-row">
          {/* (Pending v9.1 GLYPHS) lucide history is Recheck everywhere; refresh-cw is the live line's Refresh only. */}
          <History size={16} strokeWidth={2} aria-hidden className={s.recheckGlyph} />
          <span className={s.recheckText} aria-hidden data-testid="recheck-text">
            {countdown.lead} <b>{countdown.time}</b>
          </span>
          <span className={s.recheckWhen} aria-hidden data-testid="recheck-when">
            {countdown.when}
          </span>
          <VisuallyHidden>{countdown.said}</VisuallyHidden>
          {countdown.due ? null : (
            <span className={s.recheckBar} aria-hidden data-testid="recheck-bar" data-progress={countdown.progress.toFixed(3)}>
              <span style={{ transform: `scaleX(${countdown.progress})` }} />
            </span>
          )}
        </div>
      ) : null}
      {inMedical || row.status === STATUS.accompanied ? <LocationRow row={row} offline={offline} panel={panel} onNeedsConnection={onNeedsConnection} /> : null}
      {inMedical ? enrouteSlot : null}
      {answers}
    </div>
  );
}

/** (F5) Before the audit trail loads: the hold's answer is the row's last change when they line up. */
function holdFallbackOrigin(row: RequestSummary): StatusOrigin | null {
  const at = holdAnsweredAt(row);
  if (!at) return null;
  const sameMoment = Math.abs(Date.parse(row.updatedAt) - Date.parse(at)) < 2_000;
  return sameMoment ? { staffName: parseStaff(row.updatedBy).name, at } : null;
}

/**
 * (F5) The medical side's answers inside the status block, [Not found yet | Not found] [✓ In medical], labelled by
 * their actions (domain primaryActions), so a renamed answer flows through. (Pending v9.1) The left answer has
 * two states, as on the Pending cards: "⧗ Not found yet" (the hold), then "× Not found" (closes it).
 */
function BlockAnswers({ row, offline, onAnswer }: { row: RequestSummary; offline: boolean; onAnswer: (a: StatusAction) => void }) {
  const answers = primaryActions(row.status).filter((a) => a.kind === 'answer');
  const notFound = notFoundAnswer(row);
  if (answers.length === 0) return null;
  return (
    <div className={s.blockActs} data-testid="block-answers">
      {offline ? (
        <span className={s.offline}>
          <CloudOff size={13} aria-hidden />
          {NEEDS_CONNECTION}
        </span>
      ) : null}
      {answers.map((a) =>
        a.id === 'inMedical' ? (
          <Button key={a.id} size="3" color="green" className={`${s.blockBtn} lp-solid-accent`} disabled={offline} onClick={() => onAnswer(a)}>
            <Check size={16} strokeWidth={2.25} aria-hidden />
            {a.label}
          </Button>
        ) : (
          <Button
            key={a.id}
            size="3"
            variant="soft"
            color="gray"
            className={s.blockBtn}
            disabled={offline}
            aria-label={notFound.said}
            data-answer={notFound.kind}
            data-testid="not-found-answer"
            onClick={() => onAnswer(a)}
          >
            {notFound.kind === 'hold' ? <Hourglass size={16} strokeWidth={1.75} aria-hidden /> : <X size={16} strokeWidth={2.25} aria-hidden />}
            {notFound.label}
          </Button>
        ),
      )}
    </div>
  );
}

/**
 * Where medical has them, under the In medical status (pending-v8.html "The request"): a pin, the location
 * (18/650) and a pencil, or a quiet "+ Location". The whole row is the button that edits it.
 */
function LocationRow({ row, offline, panel, onNeedsConnection }: { row: RequestSummary; offline: boolean; panel: boolean; onNeedsConnection: () => void }) {
  const [editing, setEditing] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const location = (row.medicalLocation ?? '').trim();
  return (
    <>
      <button
        ref={button}
        type="button"
        className={location ? s.locRow : `${s.locRow} ${s.locEmpty}`}
        aria-label={location ? `${location}, edit location` : 'Add location'}
        aria-disabled={offline || undefined}
        data-disabled={offline ? '' : undefined}
        data-testid="location-row"
        onClick={() => {
          if (offline) {
            onNeedsConnection();
            return;
          }
          // iOS opens the keyboard only for a focus made during the tap: the sheet's field takes it over.
          if (!panel) primeKeyboard();
          setEditing(true);
        }}
      >
        {location ? (
          <>
            <MapPin size={16} aria-hidden className={s.locPin} />
            <span className={s.locValue}>{location}</span>
            <Pencil size={15} aria-hidden className={s.locEdit} />
          </>
        ) : (
          <>
            <Plus size={16} aria-hidden className={s.locPin} />
            <span className={s.locAdd}>Location</span>
          </>
        )}
      </button>
      <LocationEditor
        target={editing ? { id: row.id, name: nameOf(row), mode: 'edit', initial: location } : null}
        desk={panel}
        anchor={button}
        returnFocus={() => button.current}
        onClose={() => setEditing(false)}
      />
    </>
  );
}

function SectionLabel({ children, onEdit, editLabel }: { children: string; onEdit?: () => void; editLabel?: string }) {
  return (
    <div className={s.lbl}>
      <Heading as="h2" size="2" weight="medium" color="gray" className={s.lblText}>
        {children}
      </Heading>
      {onEdit ? (
        <Button size="1" variant="ghost" color="gray" className={`${s.hit} ${s.hitWide}`} onClick={onEdit} aria-label={editLabel}>
          <Pencil size={13} aria-hidden />
          Edit
        </Button>
      ) : null}
    </div>
  );
}

function Row({ k, children, center }: { k: string; children: ReactNode; center?: boolean }) {
  return (
    <div className={center ? `${s.r} ${s.center}` : s.r}>
      <span className={s.k}>{k}</span>
      {children}
    </div>
  );
}

const filled = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim() !== '';

function Details({ row }: { row: RequestSummary }) {
  const person: Array<[string, string | null]> = [
    [FIELD_LABELS.clothing, row.clothing],
    [FIELD_LABELS.lastSeen, row.lastSeen],
    [FIELD_LABELS.hair, row.hair],
    [FIELD_LABELS.heightBuild, row.heightBuild],
    [FIELD_LABELS.identifyingFeatures, row.identifyingFeatures],
    [FIELD_LABELS.physicalDescription, row.physicalDescription],
    [FIELD_LABELS.additionalNotes, row.additionalNotes],
  ];
  const personRows = person.filter((p): p is [string, string] => filled(p[1]));

  const name = filled(row.contactName) ? row.contactName.trim() : null;
  const relation = filled(row.contactRelationship) ? row.contactRelationship.trim() : null;
  const tel = telHref(row.contactPhone);
  const hasFriend = name || relation || filled(row.contactPhone) || filled(row.contactNotes);

  return (
    <>
      <SectionLabel onEdit={() => navigate({ r: row.id, edit: 'person' })} editLabel="Edit missing person">
        Missing person
      </SectionLabel>
      {personRows.length > 0 ? (
        <div className={s.grp} data-testid="person-details">
          {personRows.map(([k, v]) => (
            <Row key={k} k={k}>
              <span className={s.v}>{v.trim()}</span>
            </Row>
          ))}
        </div>
      ) : null}

      <SectionLabel onEdit={() => navigate({ r: row.id, edit: 'friend' })} editLabel="Edit friend or family">
        Friend or family
      </SectionLabel>
      {hasFriend ? (
        <div className={s.grp} data-testid="friend-details">
          {name ? (
            <Row k="Name">
              <span className={s.v}>{relation ? `${name} · ${relation}` : name}</span>
            </Row>
          ) : relation ? (
            <Row k="Relation">
              <span className={s.v}>{relation}</span>
            </Row>
          ) : null}
          {filled(row.contactPhone) ? (
            <Row k={FIELD_LABELS.contactPhone} center>
              <span className={s.v}>{row.contactPhone.trim()}</span>
              {tel ? (
                <Button asChild size="1" variant="soft" color="gray" className={`${s.hit} ${s.hitWide}`}>
                  <a href={tel} aria-label={`Call ${row.contactPhone.trim()}`}>
                    <Phone size={13} aria-hidden />
                    Call
                  </a>
                </Button>
              ) : null}
            </Row>
          ) : null}
          {filled(row.contactNotes) ? (
            <Row k="Notes">
              <span className={s.v}>{row.contactNotes.trim()}</span>
            </Row>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function ActionButton({ action, row, disabled, onClick }: { action: StatusAction; row: RequestSummary; disabled: boolean; onClick: () => void }) {
  // 40 px buttons with a 44 px tap target (.lp-hit); In medical in the accessible green (.lp-solid-accent).
  const common = { size: '3' as const, disabled, onClick, className: 'lp-hit' };
  switch (action.id) {
    case 'inMedical':
      return (
        <Button {...common} color="green" className="lp-hit lp-solid-accent">
          <Check size={16} aria-hidden />
          {action.label}
        </Button>
      );
    case 'reunited':
      return (
        <Button {...common} highContrast>
          <Check size={16} aria-hidden />
          {action.label}
        </Button>
      );
    case 'reopen':
      // (F6) Closed · inactive: back to In medical (Friend coming), the ⋯ menu's Reopen glyph.
      return (
        <Button {...common} variant="soft" color="gray" data-testid="reopen">
          <RotateCcw size={16} aria-hidden />
          {action.label}
        </Button>
      );
    default: {
      // Not found: (Pending v9.1) "⧗ Not found yet" (the hold) until the request is held, then "× Not found"
      // (closes it). (Change answer is ChangeAnswerMenu.)
      const answer = notFoundAnswer(row);
      return (
        <Button {...common} variant="soft" color="gray" aria-label={answer.said} data-answer={answer.kind} data-testid="not-found-answer">
          {answer.kind === 'hold' ? <Hourglass size={16} strokeWidth={1.75} aria-hidden /> : <X size={16} strokeWidth={2.25} aria-hidden />}
          {answer.label}
        </Button>
      );
    }
  }
}

/**
 * Change answer: a menu with the other answer and Back to Waiting for check, each marked with the glyph of
 * the status it moves to. A choice saves on tap (kind 'change'); the store shows the overlay and the Undo bar.
 */
function ChangeAnswerMenu({
  status,
  disabled,
  side,
  onChoose,
}: {
  status: string;
  disabled: boolean;
  /** Up from the phone's bar at the foot of the screen, down from the desk pane's row under the status. */
  side: 'top' | 'bottom';
  onChoose: (to: SettableStatus, kind: StatusKind) => void;
}) {
  const choices = changeAnswerChoices(status);
  const [answer, ...rest] = choices;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger disabled={disabled}>
        <Button size="3" variant="soft" color="gray" className="lp-hit" disabled={disabled} data-testid="change-answer">
          <Undo2 size={16} aria-hidden />
          Change answer
          <ChevronDown size={14} aria-hidden className={s.chev} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side={side} align="start" variant="soft" className={s.pmenu} data-testid="change-answer-menu">
        {answer ? <ChangeChoiceItem to={answer.to} label={answer.label} disabled={disabled} onSelect={() => onChoose(answer.to, answer.kind)} /> : null}
        {rest.length > 0 ? <DropdownMenu.Separator /> : null}
        {rest.map((c) => (
          <ChangeChoiceItem key={c.to} to={c.to} label={c.label} disabled={disabled} onSelect={() => onChoose(c.to, c.kind)} />
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

function ChangeChoiceItem({ to, label, disabled, onSelect }: { to: SettableStatus; label: string; disabled: boolean; onSelect: () => void }) {
  // Disabled when the connection drops while the menu is open (answers need a connection).
  return (
    <DropdownMenu.Item onSelect={onSelect} disabled={disabled} data-to={to}>
      <StatusGlyph status={to} size={16} />
      {label}
    </DropdownMenu.Item>
  );
}
