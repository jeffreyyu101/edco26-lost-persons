'use client';
// Pending and My requests cards. Pending is design/screens/pending-v8.html (2026-11-06 afternoon, Brian +
// Dani) with Pending v9.1 (Brian 2026-11-06 19:35–20:40, design/screens/pending-v9.html): Waiting for check
// (CheckCard) and Friend coming (ComingCard). My requests is requests.html MCard + Stepper.
// Each card opens the profile through a transparent button stretched over it; the action buttons and the
// location chip sit above that button. A photo shows only when the request has one: no empty placeholders.
import { Badge, Button, Card, Text, VisuallyHidden } from '@radix-ui/themes';
import { Check, CircleAlert, Clock, Hourglass, MapPin, Plus, UserRound, X } from 'lucide-react';
import { memo, useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { StageGlyph } from '@/components/ui/StageGlyph';
import { CheckPreview, ComingEnroute, MessageButton, MessageIconButton, MineActivity, useHasMessages } from '@/components/messages/CardActivity';
import m from '@/components/messages/messages.module.css';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import { HoldChip, StageChip, hasStageChip } from './StageChips';
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { photoPath } from '@/lib/client/api-paths';
import { navigate } from '@/lib/client/nav';
import { ANSWER_LABEL, NOT_FOUND_YET_LABEL, STATUS, ageGender, isHeld, isRecheckDue, statusMeta, waitTone } from '@/lib/domain';
import { displayStage, notFoundAnswer, type StageTone } from '@/lib/stages';
import { formatCaseNumber, formatDuration, minutesSince } from '@/lib/format';
import {
  cardDescription,
  displayName,
  isClosed,
  isFresh,
  minutesPhrase,
  outboxDisplay,
  queuedStepper,
  statusSince,
  stepperModel,
  whoPhrase,
  type StepperModel,
} from './list-helpers';
import s from './list.module.css';

/** (F5) A stage label's Radix colour on the card's solid panel: its tone (step 11), grey inherits the card's. */
function stageTextColor(tone: StageTone): Exclude<StageTone, 'gray'> | undefined {
  return tone === 'gray' ? undefined : tone;
}

// ---------------------------------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------------------------------

export function photoThumbUrl(photoId: string): string {
  return photoPath(photoId, 'thumb');
}

/** The request's first photo (thumbnail size, 40 px, My requests). Nothing when it has none. */
export function Thumb({ photoId }: { photoId: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!photoId) return null;
  if (failed === photoId) {
    // Offline or expired: keep the "has a photo" look without the image.
    return (
      <div className={`${s.thumb} ${s.thumbPhoto}`}>
        <UserRound size={22} strokeWidth={1.75} aria-hidden />
      </div>
    );
  }
  return (
    <div className={`${s.thumb} ${s.thumbPhoto}`}>
      <img
        src={photoThumbUrl(photoId)}
        alt=""
        width={40}
        height={40}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(photoId)}
      />
    </div>
  );
}

/** Pending's portrait photo (pending-v8.html .photo): 60 × 72, or 52 × 62 on a Friend coming card. */
function Portrait({ photoId, small }: { photoId: string; small?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <div className={small ? `${s.pphoto} ${s.pphotoSm}` : s.pphoto} data-testid="card-photo">
      {failed === photoId ? (
        // Offline or expired: keep the "has a photo" look without the image.
        <UserRound size={small ? 24 : 28} strokeWidth={1.75} aria-hidden />
      ) : (
        <img
          src={photoThumbUrl(photoId)}
          alt=""
          width={small ? 52 : 60}
          height={small ? 62 : 72}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(photoId)}
        />
      )}
    </div>
  );
}

/** A queued request's first photo, straight from the blob saved on this phone. Nothing when it has none. */
function OutboxThumb({ item }: { item: OutboxItem }) {
  const blob = item.photos[0]?.thumbBlob ?? null;
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const el = img.current;
    if (!blob || !el) return;
    // An object URL for exactly as long as this blob is shown (the CSP's img-src allows blob:).
    const url = URL.createObjectURL(blob);
    el.src = url;
    return () => {
      el.removeAttribute('src');
      URL.revokeObjectURL(url);
    };
  }, [blob]);
  if (!blob) return null;
  return (
    <div className={`${s.thumb} ${s.thumbPhoto}`}>
      <img ref={img} alt="" width={40} height={40} decoding="async" draggable={false} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------------

/**
 * Wait badge (My requests): grey under 10 min, amber 10–19, red at 20 or more (requests.html Wait). Amber
 * and red use the scale's step 12 for the text: step 11 on its own tint is under 4.5:1 (spec §7).
 */
export function WaitBadge({ minutes }: { minutes: number }) {
  const tone = waitTone(minutes);
  return (
    <Badge size="1" variant="soft" color={tone} highContrast={tone !== 'gray'} style={{ flex: 'none' }}>
      <Clock size={12} strokeWidth={1.75} aria-hidden className={s.badgeIcon} />
      {formatDuration(minutes)}
    </Badge>
  );
}

/**
 * Pending's minutes beside the name (pending-v8.html .wait): grey, amber from 10, red from 20, as plain
 * step-11 text on the card's solid panel (4.5:1 in both themes). Waiting for check adds the clock glyph (how
 * long it has waited); Friend coming shows the minutes since the In medical answer, always grey (Pending v9.1:
 * red and amber mean "waiting for check too long" and never appear on a found patient).
 */
function Minutes({ minutes, clock }: { minutes: number; clock?: boolean }) {
  return (
    <span className={s.pwait} data-tone={clock ? waitTone(minutes) : 'gray'} data-testid="card-minutes">
      {clock ? <Clock size={13} strokeWidth={2} aria-hidden /> : null}
      {formatDuration(minutes)}
    </span>
  );
}

/**
 * Name + age/sex, then "LP-1010 · FA 4" (requests.html Who). `nameId` / `subId` let the card's action
 * buttons point at this text (aria-describedby works on hidden text) without repeating it.
 */
function Who({ name, ag, sub, nameId, subId }: { name: string; ag: string; sub: string; nameId?: string; subId?: string }) {
  return (
    <div className={s.qn}>
      <div className={s.l1}>
        <Text size="3" weight="medium" id={nameId}>
          {name}
        </Text>
        {ag ? (
          <Text size="2" color="gray" className={s.nowrap}>
            {ag}
          </Text>
        ) : null}
      </div>
      <Text size="1" color="gray" truncate id={subId}>
        {sub}
      </Text>
    </div>
  );
}

export function Stepper({ model }: { model: StepperModel }) {
  return (
    // Equal columns, except that no label is ever cut: a column is at least as wide as its label ("Not found in
    // medical" on a 375 px phone).
    <div className={s.stepper} style={{ gridTemplateColumns: `repeat(${model.steps.length}, minmax(max-content, 1fr))` }}>
      {model.steps.map((label, i) => {
        const step = i < model.current ? 'done' : i === model.current ? model.mode : 'todo';
        return (
          <div key={label} className={s.st} data-step={step} style={{ '--tone': model.color } as CSSProperties}>
            <span className={s.dot} />
            <span className={s.lb}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function OpenButton({ id, label, describedBy }: { id: string; label: string; describedBy?: string }) {
  return (
    <button
      type="button"
      className={s.stretch}
      data-request-id={id}
      aria-label={label}
      aria-describedby={describedBy}
      onClick={() => navigate({ r: id })}
    />
  );
}

/** Offline, status buttons look disabled but still take the tap (to explain "Needs a connection"). */
function offlineProps(offline: boolean) {
  return offline ? { 'aria-disabled': true, 'data-disabled': '' } : {};
}

/** The card a control sits on (where the desk's location popover first points). */
const cardOf = (e: MouseEvent<HTMLElement>): HTMLElement | null => e.currentTarget.closest<HTMLElement>('[data-pending-card]');

// ---------------------------------------------------------------------------------------------------
// Pending: Waiting for check (CheckCard) and Friend coming (ComingCard), pending-v8.html + pending-v9.html
// ---------------------------------------------------------------------------------------------------

export interface CheckCardProps {
  row: RequestSummary;
  now: number;
  offline: boolean;
  onNotInMedical: (row: RequestSummary) => void;
  /** `card` is the tapped card (where the desk's location popover first points). */
  onInMedical: (row: RequestSummary, card: HTMLElement | null) => void;
  /** (Pending v9.1) A copy of the card animating out of Pending after its final Not found (inert, hidden). */
  leaving?: boolean;
}

/**
 * The left answer's longer label ("Pending" / "Not located"): its invisible copy keeps the button one width in both
 * states (list.module.css .ansLabel).
 */
const ANSWER_SIZE_AS = NOT_FOUND_YET_LABEL.length >= ANSWER_LABEL.notFound.length ? NOT_FOUND_YET_LABEL : ANSWER_LABEL.notFound;

/** (Pending v9.1) The hold's indicator for a card: none, held ("Pending") or due ("Recheck due"). */
export function holdState(row: Pick<RequestSummary, 'status' | 'recheckAt'>, now: number): 'none' | 'held' | 'due' {
  if (!isHeld(row)) return 'none';
  return isRecheckDue(row, now) ? 'due' : 'held';
}

/**
 * Waiting for check: the photo when there is one, the name or initials (18/600) and age/sex, how long it has
 * waited (clock; amber from 10, red from 20), what they're wearing (2 lines), one quiet "FA 4 · LP-0010" line.
 * (Pending v9.1) The wait is the only time on the card. While on a "Not found yet" hold a chip row says so
 * (outlined "⧗ Not found yet", then a filled "↺ Recheck due"); nothing else moves. Then the answers (44 px): the
 * left one is "⧗ Not found yet" (the first Not found, the hold) or, once held, "× Not found" (the final answer,
 * which closes it), in the same style, width and place; then ✓ In medical.
 */
export const CheckCard = memo(function CheckCard({ row, now, offline, onNotInMedical, onInMedical, leaving = false }: CheckCardProps) {
  const reasonId = useId();
  const nameId = useId();
  const metaId = useId();
  const minutes = minutesSince(row.createdAt, now);
  const desc = cardDescription(row);
  const ag = ageGender(row.age, row.gender);
  const hold = holdState(row, now);
  const answer = notFoundAnswer(row);
  const meta = `${row.postShort} · ${formatCaseNumber(row.caseNumber)}`;
  const holdSaid = hold === 'due' ? `${NOT_FOUND_YET_LABEL}, recheck due. ` : hold === 'held' ? `${NOT_FOUND_YET_LABEL}. ` : '';
  const label = `${whoPhrase(row)}. ${meta}. ${holdSaid}Waiting ${minutesPhrase(minutes)}.${desc ? ` ${desc}` : ''}`;
  const fresh = isFresh(row.createdAt, now);
  const describedBy = offline ? `${nameId} ${metaId} ${reasonId}` : `${nameId} ${metaId}`;
  const messages = useHasMessages();
  return (
    <div
      className={`${s.pcard} ${fresh ? s.fresh : ''} ${leaving ? s.leaving : ''}`}
      data-testid={leaving ? 'leaving-card' : 'check-card'}
      data-pending-card={leaving ? undefined : row.id}
      data-hold={hold === 'none' ? undefined : hold}
      {...(leaving ? { inert: true, 'aria-hidden': true } : {})}
    >
      {leaving ? null : <OpenButton id={row.id} label={label} />}
      <div className={s.pwho} aria-hidden>
        {row.firstPhotoId ? <Portrait photoId={row.firstPhotoId} /> : null}
        <div className={s.pwt}>
          <div className={s.pl1}>
            <span className={s.pnm} id={nameId}>
              {displayName(row.name)}
            </span>
            {ag ? <span className={s.pas}>{ag}</span> : null}
            <Minutes minutes={minutes} clock />
          </div>
          {desc ? <p className={s.pdesc}>{desc}</p> : null}
          <span className={s.pmeta} id={metaId}>
            {meta}
          </span>
        </div>
      </div>
      {hold === 'none' ? null : (
        <div className={s.chipRow}>
          <HoldChip due={hold === 'due'} />
        </div>
      )}
      {/* F3: the last message, then Message left of the answers (updates.html #clarify 3). */}
      <CheckPreview row={row} />
      <div className={`${messages ? m.checkActs : s.pacts} ${s.actions}`}>
        {messages ? <MessageIconButton row={row} /> : null}
        <Button
          size="3"
          variant="soft"
          color="gray"
          className={`${s.pbtn} ${s.pbtnSoft}`}
          {...offlineProps(offline)}
          aria-label={answer.said}
          aria-describedby={describedBy}
          data-answer={answer.kind}
          data-testid="not-found-answer"
          onClick={() => onNotInMedical(row)}
        >
          {answer.kind === 'hold' ? <Hourglass size={16} strokeWidth={1.75} aria-hidden /> : <X size={16} strokeWidth={2.25} aria-hidden />}
          {/* Sized for the longer of its two labels, so it keeps one width and place in both states. */}
          <span className={s.ansLabel} data-size-as={ANSWER_SIZE_AS}>
            {answer.label}
          </span>
        </Button>
        <Button
          size="3"
          color="green"
          className={`${s.pbtn} lp-solid-accent`}
          {...offlineProps(offline)}
          aria-describedby={describedBy}
          onClick={(e) => onInMedical(row, cardOf(e))}
        >
          <Check size={16} strokeWidth={2.25} aria-hidden />
          {ANSWER_LABEL.inMedical}
        </Button>
      </div>
      {offline ? <VisuallyHidden id={reasonId}>Needs a connection</VisuallyHidden> : null}
    </div>
  );
});

export interface ComingCardProps {
  row: RequestSummary;
  now: number;
  offline: boolean;
  onReunited: (row: RequestSummary) => void;
  /** The location chip: add or edit where medical has them. `card` is the card it sits on. */
  onLocate: (row: RequestSummary, card: HTMLElement | null) => void;
}

/**
 * Friend coming: the photo when there is one, the name and age/sex, the minutes since the In medical answer,
 * where medical has them (a green chip with a pin, or a quiet "+ Location" chip; either one edits it), then a
 * full-width Reunited. (Pending v9.1) No "→ friend · relationship" line: the request has it.
 */
export const ComingCard = memo(function ComingCard({ row, now, offline, onReunited, onLocate }: ComingCardProps) {
  const reasonId = useId();
  const nameId = useId();
  const minutes = minutesSince(statusSince(row), now);
  const ag = ageGender(row.age, row.gender);
  const location = (row.medicalLocation ?? '').trim();
  const label = `${whoPhrase(row)}. ${statusMeta(STATUS.inMedical).shortLabel}${location ? `, ${location}` : ''}, ${minutesPhrase(minutes)} ago. ${row.postShort} · ${formatCaseNumber(row.caseNumber)}.`;
  const describedBy = offline ? `${nameId} ${reasonId}` : nameId;
  const messages = useHasMessages();
  const reunited = (
    <Button
      size="3"
      highContrast
      className={`${s.pbtn} ${s.actions}`}
      {...offlineProps(offline)}
      aria-describedby={describedBy}
      onClick={() => onReunited(row)}
    >
      <Check size={16} strokeWidth={2.25} aria-hidden />
      Reunited
    </Button>
  );
  return (
    <div className={s.pcard} data-testid="friend-coming-card" data-pending-card={row.id}>
      <OpenButton id={row.id} label={label} />
      <div className={s.pwho}>
        {row.firstPhotoId ? <Portrait photoId={row.firstPhotoId} small /> : null}
        <div className={s.pwt}>
          <div className={s.pl1} aria-hidden>
            <span className={s.pnm} id={nameId}>
              {displayName(row.name)}
            </span>
            {ag ? <span className={s.pas}>{ag}</span> : null}
            <Minutes minutes={minutes} />
          </div>
          <div className={s.plocRow}>
            <button
              type="button"
              className={location ? s.loc : `${s.loc} ${s.locAdd}`}
              data-location-anchor={row.id}
              data-testid="location-chip"
              aria-label={location ? `${location}, edit location` : 'Add location'}
              aria-describedby={describedBy}
              {...offlineProps(offline)}
              onClick={(e) => onLocate(row, cardOf(e))}
            >
              {location ? <MapPin size={14} strokeWidth={2} aria-hidden /> : <Plus size={14} strokeWidth={2} aria-hidden />}
              <span className={s.locText}>{location || 'Location'}</span>
            </button>
          </div>
        </div>
      </div>
      {/* F3: who is bringing the friend, then Message | Reunited (updates.html v7 "4 · Pending"). */}
      {messages ? (
        <>
          <ComingEnroute row={row} />
          <div className={`${m.cardBtns} ${s.actions}`}>
            <MessageButton row={row} />
            {reunited}
          </div>
        </>
      ) : (
        reunited
      )}
      {offline ? <VisuallyHidden id={reasonId}>Needs a connection</VisuallyHidden> : null}
    </div>
  );
});

// ---------------------------------------------------------------------------------------------------
// My requests: MCard (with the progress stepper) and queued requests
// ---------------------------------------------------------------------------------------------------

export const MineCard = memo(function MineCard({
  row,
  now,
  freshTone,
  timeZone,
}: {
  row: RequestSummary;
  now: number;
  freshTone: string | null;
  /** (F5) The event timezone, for the stage's words. */
  timeZone?: string;
}) {
  const closed = isClosed(row.status);
  const waiting = row.status === STATUS.waiting;
  const minutes = minutesSince(waiting ? row.createdAt : statusSince(row), now);
  const sub = `${formatCaseNumber(row.caseNumber)} · ${row.postShort}`;
  // (F5) The stage: a chip in the corner for Needs info, the stage's glyph and label otherwise. (Pending v9.1) A
  // hold keeps the wait in the corner and says "Not found yet" / "Recheck due" in a chip row: no recheck time.
  const stage = displayStage(row, { now, ...(timeZone ? { timeZone } : {}) });
  const chip = hasStageChip(stage);
  const hold = holdState(row, now);
  const holdSaid = hold === 'due' ? `${NOT_FOUND_YET_LABEL.toLowerCase()}, recheck due` : hold === 'held' ? NOT_FOUND_YET_LABEL.toLowerCase() : '';
  const stageSaid = stage.key === 'needsInfo' ? stage.said : hold !== 'none' ? '' : statusMeta(row.status).label;
  const said = [stageSaid, holdSaid].filter(Boolean).join(', ').replace(/^./, (c) => c.toUpperCase());
  const label = `${whoPhrase(row)}. ${sub}. ${said}${waiting ? `, waiting ${minutesPhrase(minutes)}` : `, ${minutesPhrase(minutes)} ago`}.`;
  return (
    <Card
      size="2"
      className={`${s.card} ${freshTone ? s.fresh : ''} ${closed ? s.dimCard : ''}`}
      data-tone={freshTone ?? undefined}
      data-testid="mine-card"
    >
      <OpenButton id={row.id} label={label} />
      <div aria-hidden>
        <div className={s.qh}>
          <Thumb photoId={row.firstPhotoId} />
          <Who name={displayName(row.name)} ag={ageGender(row.age, row.gender)} sub={sub} />
          {chip ? (
            <StageChip stage={stage} />
          ) : waiting ? (
            <WaitBadge minutes={minutes} />
          ) : (
            <Text size="1" color="gray" className={s.nowrap}>
              {formatDuration(minutes)}
            </Text>
          )}
        </div>
        {hold !== 'none' ? (
          <div className={s.stageRow}>
            <HoldChip due={hold === 'due'} />
          </div>
        ) : chip ? null : (
          <div className={s.stat}>
            <StageGlyph glyph={stage.glyph} size={15} />
            <Text size="2" weight="medium" color={stageTextColor(stage.tone)}>
              {stage.key === 'inMedical' ? stage.fullLabel : stage.label}
            </Text>
          </div>
        )}
        <Stepper model={stepperModel(row.status)} />
      </div>
      {/* F3: en route, the last message, En route / Reunited and Message (updates.html v7 "2 · My requests"; no Arrived since 2026-11-08). */}
      <MineActivity row={row} />
    </Card>
  );
});

export function OutboxCard({ item, now }: { item: OutboxItem; now: number }) {
  const d = outboxDisplay(item);
  const minutes = minutesSince(item.createdAt, now);
  const sub = `${d.caseText} · ${d.post}`;
  const label = `${d.ageGender ? `${d.name}, ${d.ageGender}` : d.name}. ${d.post}. ${d.label}, saved on this phone ${minutesPhrase(minutes)} ago.${d.needsAttention ? ' Open to fix and resend.' : ''}`;
  return (
    <Card
      size="2"
      className={s.card}
      data-outbox-id={item.mutationId}
      data-testid="outbox-card"
      {...(d.needsAttention ? {} : { role: 'group', 'aria-label': label })}
    >
      {d.needsAttention ? (
        <button
          type="button"
          className={s.stretch}
          aria-label={label}
          onClick={() => navigate({ outbox: item.mutationId })}
        />
      ) : null}
      <div aria-hidden>
        <div className={s.qh}>
          <OutboxThumb item={item} />
          <Who name={d.name} ag={d.ageGender} sub={sub} />
          <Text size="1" color="gray" className={s.nowrap}>
            {formatDuration(minutes)}
          </Text>
        </div>
        <div className={s.stat}>
          {d.needsAttention ? (
            <CircleAlert size={15} strokeWidth={2} className={s.attention} aria-hidden />
          ) : (
            <StatusGlyph kind="queued" size={15} />
          )}
          <Text size="2" weight="medium" color={d.needsAttention ? 'red' : undefined}>
            {d.label}
          </Text>
        </div>
        <Stepper model={queuedStepper(d.needsAttention)} />
      </div>
    </Card>
  );
}
