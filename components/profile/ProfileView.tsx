'use client';
// Request profile (?r=<id>, spec §8 Profile; design/screens/profile.html + states.html "Photo"). Renders
// immediately from the synced summary (or from the detail when a deep link arrives before the row has
// synced); photos and the audit trail come from useDetail(id), which refetches whenever the synced
// rowVersion changes, and show skeletons until it loads.
//
//   top bar      × · LP number · ⋯ (Edit details, Mark discharged while In medical, Reopen when closed —
//                Cancelled → Waiting creator-only —, Cancel request creator-only while Waiting)
//   header       portrait + photo count, name, age · gender, post · who logged it
//   status block status colour; wait badge while Waiting; "Rae Chen · 11:10 · Maya R. heading to Main
//                Med" while In medical; who and when for the other answers
//   details      Missing person / Friend or family, filled fields only, each with Edit; Phone has Call
//   photos       tiles → full-screen viewer; Add tile (needs a connection) until there are 3
//   audit trail  newest first (audit-trail.ts)
//   actions      sticky, by status; disabled offline with "Needs a connection"
//   cancel       red, creator-only (canonical created_by match, A18), while Waiting, confirm Keep / Cancel
//   conflict     "Updated by someone else" when another person's change arrives while it is open
import { AlertDialog, Badge, Button, DropdownMenu, Heading, IconButton, Skeleton, Text, VisuallyHidden } from '@radix-ui/themes';
import { Camera, Check, Clock, CloudOff, Ellipsis, Pencil, Phone, RotateCcw, Trash2, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Banner } from '@/components/ui/Banner';
import { EmptyState } from '@/components/ui/EmptyState';
import { ProfileSkeleton } from '@/components/ui/Skeleton';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import type { RequestDetail, RequestSummary } from '@/lib/api-types';
import { goBack, navigate } from '@/lib/client/nav';
import {
  useActions,
  useConnection,
  useDetail,
  useEventTimezone,
  useIsLoading,
  useNow,
  useRequest,
  useSession,
  type MutationResult,
} from '@/lib/client/store-contract';
import {
  FIELD_LABELS,
  MAX_PHOTOS,
  PHOTO_TIMING_LABEL,
  STATUS,
  canCancel,
  isInMedical,
  isStatus,
  menuActions,
  parseStaff,
  postFull,
  primaryActions,
  sameStaff,
  statusMeta,
  telHref,
  waitTone,
  type PhotoTiming,
  type StatusAction,
} from '@/lib/domain';
import { formatCaseNumber, formatDuration, formatListTime, minutesSince } from '@/lib/format';
import { AddPhotosSheet, type PhotoPick } from './AddPhotos';
import { AuditTrail, AuditTrailSkeleton } from './AuditTrail';
import { buildAuditTrail, statusOrigin, type StatusOrigin } from './audit-trail';
import { Bust } from './Bust';
import { PhotoViewer, photoUrl } from './PhotoViewer';
import s from './profile.module.css';

export interface ProfileViewProps {
  /** Request id from ?r=. */
  id: string;
}

/** How long the "Updated by someone else" banner stays up. */
const CONFLICT_BANNER_MS = 8_000;
const NEEDS_CONNECTION = 'Needs a connection';
const NO_NAME = 'Name not provided';

const close = () => goBack({});

export function ProfileView({ id }: ProfileViewProps) {
  const storeRow = useRequest(id);
  const { detail, loading: detailLoading, error: detailError, refresh } = useDetail(id);
  const storeLoading = useIsLoading();
  // A deep link can arrive before the row has synced: the detail is a full RequestSummary too.
  const row: RequestSummary | null = storeRow ?? detail;

  // Views share one document: start a profile at the top, not at the list's scroll position.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [id]);

  if (!row) {
    const settled = !storeLoading && !detailLoading;
    if (settled && detailError === 'not_found') {
      return (
        <Frame>
          <EmptyState icon="search" title="Request not found" action={{ label: 'Back', onClick: close }} />
        </Frame>
      );
    }
    if (settled && detailError && detailError !== 'unauthorized') {
      return (
        <Frame>
          <EmptyState icon="plug" title="Can't reach the log" action={{ label: 'Try again', onClick: refresh, icon: 'refresh' }} />
        </Frame>
      );
    }
    return (
      <Frame>
        <ProfileSkeleton />
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
    />
  );
}

/** The bare top bar (× only) around the loading / not-found states. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className={s.app} data-testid="profile">
      <div className={s.nav}>
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
}

type AddState = { picks: PhotoPick[]; unreadable: number; phase: 'preparing' | 'ready' | 'uploading'; error: string | null };
type CancelState = { busy: boolean; error: string | null };

function Profile({ row, detail, detailLoading, detailFailed, refresh }: ProfileProps) {
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
  const origin = useMemo(() => (detail ? statusOrigin(detail.audit, row.status) : null), [detail, row.status]);

  // --- Someone else changed it while it was open ------------------------------------------------------
  const [seenVersion, setSeenVersion] = useState(row.rowVersion);
  const conflict = row.rowVersion > seenVersion && !sameStaff(row.updatedBy, session.staff);
  useEffect(() => {
    if (!conflict) return;
    const timer = setTimeout(() => setSeenVersion(row.rowVersion), CONFLICT_BANNER_MS);
    return () => clearTimeout(timer);
  }, [conflict, row.rowVersion]);

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
  const livePicks = useRef<PhotoPick[]>([]);
  useEffect(() => {
    const picks = livePicks;
    return () => revoke(picks.current);
  }, []);

  const closeAdd = useCallback(() => {
    addRun.current += 1;
    revoke(livePicks.current);
    livePicks.current = [];
    setAdd(null);
  }, []);

  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    const room = MAX_PHOTOS - photoCount;
    if (files.length === 0 || room <= 0) return;
    const run = (addRun.current += 1);
    revoke(livePicks.current);
    livePicks.current = [];
    setAdd({ picks: [], unreadable: 0, phase: 'preparing', error: null });
    const picks: PhotoPick[] = [];
    let unreadable = 0;
    // One at a time: decoding several camera photos at once can exhaust iOS memory.
    for (const file of files.slice(0, room)) {
      try {
        const photo = await actions.preparePhoto(file);
        if (addRun.current !== run) return;
        const pick = { photo, url: URL.createObjectURL(photo.thumbBlob) };
        picks.push(pick);
        livePicks.current = [...picks];
      } catch {
        unreadable += 1;
      }
    }
    if (addRun.current !== run) return;
    setAdd({ picks, unreadable, phase: 'ready', error: null });
  };

  const onAdd = async (timing: PhotoTiming) => {
    if (!add || add.picks.length === 0) return;
    const run = addRun.current;
    const picks = add.picks;
    setAdd({ ...add, phase: 'uploading', error: null });
    let failed = picks.length;
    try {
      ({ failed } = await actions.addPhotos(row.id, picks.map((p) => p.photo), timing));
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
  // The dialog closes by itself if the request stops being cancellable (someone answered it), unless a
  // cancel is in flight or its error is showing.
  const confirmOpen = cancelState !== null && (cancellable || cancelState.busy || cancelState.error !== null);
  const openCancel = () => setCancelState({ busy: false, error: null });
  const doCancel = async () => {
    if (offline) {
      setCancelState({ busy: false, error: NEEDS_CONNECTION });
      return;
    }
    setCancelState({ busy: true, error: null });
    let result: MutationResult;
    try {
      result = await actions.cancel(row.id);
    } catch {
      result = { ok: false, reason: 'failed', message: '' };
    }
    if (result.ok) setCancelState(null);
    else setCancelState({ busy: false, error: failureMessage(result) });
  };

  const setStatus = (a: StatusAction) => void actions.setStatus(row.id, a.to, a.kind);
  const menu = menuActions(row.status, isCreator);
  const footer = primaryActions(row.status);

  return (
    <div className={s.app} data-testid="profile" data-status={row.status}>
      <div className={s.nav}>
        <CloseButton />
        <Text size="2" weight="medium" color="gray" data-testid="profile-case">
          {label}
        </Text>
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger>
            <IconButton variant="soft" color="gray" radius="full" aria-label="More actions" className={s.hit}>
              <Ellipsis size={16} aria-hidden />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" variant="soft">
            <DropdownMenu.Item onSelect={() => navigate({ r: row.id, edit: 'all' })}>
              <Pencil size={15} aria-hidden />
              Edit details
            </DropdownMenu.Item>
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

        <StatusBlock row={row} origin={origin} originLoading={!detail && detailLoading} now={now} timeZone={timeZone} />

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
                  type="file"
                  accept="image/*"
                  multiple
                  disabled={offline || add !== null}
                  aria-label={offline ? `Add photo (${NEEDS_CONNECTION.toLowerCase()})` : 'Add photo'}
                  onChange={(e) => void onFiles(e)}
                />
              </VisuallyHidden>
            </label>
          ) : null}
        </div>

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

      {footer.length > 0 ? (
        <div className={s.foot} data-layout={footer.length === 1 ? 'one' : isInMedical(row.status) ? 'one-two' : 'two'} data-testid="profile-actions">
          {offline ? (
            <span className={s.offline}>
              <CloudOff size={13} aria-hidden />
              {NEEDS_CONNECTION}
            </span>
          ) : null}
          {footer.map((a) => (
            <ActionButton key={a.id} action={a} disabled={offline} onClick={() => setStatus(a)} />
          ))}
        </div>
      ) : null}

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
              <Button size="3" variant="soft" color="gray" disabled={cancelState?.busy}>
                Keep
              </Button>
            </AlertDialog.Cancel>
            <Button size="3" color="red" loading={cancelState?.busy} onClick={() => void doCancel()}>
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
    return (
      <button type="button" className={s.portrait} aria-label={`Open photos (${count})`} onClick={onOpen}>
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
  const at = isInMedical(row.status)
    ? (row.reunionStartedAt ?? row.foundAt)
    : statusMeta(row.status).bucket === 'closed'
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
}: {
  row: RequestSummary;
  origin: StatusOrigin | null;
  originLoading: boolean;
  now: number;
  timeZone: string;
}) {
  const meta = statusMeta(row.status);
  const waiting = row.status === STATUS.waiting;
  let sub: ReactNode = null;
  let badge: ReactNode = null;
  if (waiting) {
    sub = `Logged ${formatListTime(row.createdAt, now, timeZone)}`;
    const minutes = minutesSince(row.createdAt, now);
    badge = (
      <Badge size="2" variant="soft" color={waitTone(minutes)} data-testid="wait-badge">
        <Clock size={13} aria-hidden />
        <VisuallyHidden>Waiting </VisuallyHidden>
        {formatDuration(minutes)}
      </Badge>
    );
  } else if (isStatus(row.status)) {
    const o = origin ?? fallbackOrigin(row);
    const parts = o ? [o.staffName, formatListTime(o.at, now, timeZone)].filter(Boolean) : [];
    if (isInMedical(row.status)) parts.push(`${row.contactName?.trim() || 'Friend'} heading to Main Med`);
    if (parts.length > 0) sub = parts.join(' · ');
    else if (originLoading) sub = <Skeleton height="12px" width="45%" style={{ marginTop: 2 }} />;
  }
  return (
    <div className={s.status} data-tone={meta.tone} data-testid="status-block">
      <StatusGlyph status={row.status} size={18} />
      <div className={s.sx}>
        <Text size="3" weight="medium" color={meta.tone}>
          {meta.label}
        </Text>
        {sub ? (
          <Text as="div" size="1" color="gray">
            {sub}
          </Text>
        ) : null}
      </div>
      {badge}
    </div>
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

function ActionButton({ action, disabled, onClick }: { action: StatusAction; disabled: boolean; onClick: () => void }) {
  const common = { size: '3' as const, disabled, onClick };
  switch (action.id) {
    case 'inMedical':
      return (
        <Button {...common} color="green">
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
    case 'notInMedical':
      return (
        <Button {...common} variant="soft" color="gray">
          <X size={16} aria-hidden />
          {action.label}
        </Button>
      );
    default:
      // Change answer (to Not in medical / to In medical).
      return (
        <Button {...common} variant="soft" color="gray" aria-label={`${action.label} to ${statusMeta(action.to).shortLabel}`}>
          <Undo2 size={16} aria-hidden />
          {action.label}
        </Button>
      );
  }
}
