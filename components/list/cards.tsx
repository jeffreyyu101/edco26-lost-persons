'use client';
// Pending and My requests cards (requests.html QCard, ComingCard, MCard + Stepper). Each card opens the
// profile through a transparent button stretched over it; the action buttons sit above that button.
import { Badge, Button, Card, Text, VisuallyHidden } from '@radix-ui/themes';
import { ArrowRight, Check, CircleAlert, Clock, UserRound, X } from 'lucide-react';
import { memo, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { navigate } from '@/lib/client/nav';
import { STATUS, ageGender, statusMeta, waitTone } from '@/lib/domain';
import { formatCaseNumber, formatDuration, minutesSince } from '@/lib/format';
import {
  DIM_OPACITY,
  cardDescription,
  displayName,
  isClosed,
  isFresh,
  labelColor,
  minutesPhrase,
  outboxDisplay,
  queuedStepper,
  statusSince,
  stepperModel,
  whoPhrase,
  type StepperModel,
} from './list-helpers';
import s from './list.module.css';

const dim = (closed: boolean): CSSProperties | undefined => (closed ? { opacity: DIM_OPACITY } : undefined);

// ---------------------------------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------------------------------

export function photoThumbUrl(photoId: string): string {
  return `/api/photos/${encodeURIComponent(photoId)}?size=thumb`;
}

/** The request's first photo (thumbnail size), or the "no photo" placeholder (requests.html .thumb). */
export function Thumb({ photoId, small }: { photoId: string | null; small?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const size = small ? `${s.thumb} ${s.thumbSmall}` : s.thumb;
  if (!photoId) {
    return (
      <div className={`${size} ${s.thumbNone}`}>
        <UserRound size={18} strokeWidth={1.75} aria-hidden />
      </div>
    );
  }
  if (failed === photoId) {
    // Offline or expired: keep the "has a photo" look without the image.
    return (
      <div className={`${size} ${s.thumbPhoto}`}>
        <UserRound size={small ? 20 : 22} strokeWidth={1.75} aria-hidden />
      </div>
    );
  }
  return (
    <div className={`${size} ${s.thumbPhoto}`}>
      <img
        src={photoThumbUrl(photoId)}
        alt=""
        width={small ? 36 : 40}
        height={small ? 36 : 40}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(photoId)}
      />
    </div>
  );
}

/** A queued request's first photo, straight from the blob saved on this phone. */
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
  if (!blob) return <Thumb photoId={null} />;
  return (
    <div className={`${s.thumb} ${s.thumbPhoto}`}>
      <img ref={img} alt="" width={40} height={40} decoding="async" draggable={false} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------------

/** Wait badge: grey under 10 min, amber 10–19, red at 20 or more (requests.html Wait). */
export function WaitBadge({ minutes }: { minutes: number }) {
  return (
    <Badge size="1" variant="soft" color={waitTone(minutes)} style={{ flex: 'none' }}>
      <Clock size={12} strokeWidth={1.75} aria-hidden className={s.badgeIcon} />
      {formatDuration(minutes)}
    </Badge>
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
    <div className={s.stepper} style={{ gridTemplateColumns: `repeat(${model.steps.length}, 1fr)` }}>
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

// ---------------------------------------------------------------------------------------------------
// Pending: Friend coming (ComingCard) and Waiting for check (QCard)
// ---------------------------------------------------------------------------------------------------

interface ActionCardProps {
  row: RequestSummary;
  now: number;
  offline: boolean;
  onTap: (id: string, to: typeof STATUS.notInMedical | typeof STATUS.inMedical | typeof STATUS.reunited, kind: 'answer' | 'reunite') => void;
}

export const ComingCard = memo(function ComingCard({ row, now, offline, onTap }: ActionCardProps) {
  const reasonId = useId();
  const nameId = useId();
  const minutes = minutesSince(statusSince(row), now);
  const friend = (row.contactName ?? '').trim();
  const ag = ageGender(row.age, row.gender);
  const from = `from ${row.postShort}`;
  const line = [friend, from, formatDuration(minutes)].filter(Boolean).join(' · ');
  const label = `${whoPhrase(row)}. In medical. ${friend ? `${friend} is` : 'The friend is'} coming ${from}, set off ${minutesPhrase(minutes)} ago. ${formatCaseNumber(row.caseNumber)}.`;
  return (
    <Card size="1" className={s.card} data-testid="friend-coming-card">
      <OpenButton id={row.id} label={label} />
      <div className={s.cc}>
        <Thumb photoId={row.firstPhotoId} small />
        <div className={s.qn} aria-hidden>
          <div className={s.l1}>
            <Text size="2" weight="medium" id={nameId}>
              {displayName(row.name)}
            </Text>
            {ag ? (
              <Text size="2" color="gray" className={s.nowrap}>
                {ag}
              </Text>
            ) : null}
          </div>
          <span className={s.who}>
            <ArrowRight size={12} strokeWidth={1.75} aria-hidden />
            <span>{line}</span>
          </span>
        </div>
        <Button
          size="2"
          variant="soft"
          color="gray"
          highContrast
          className={s.actions}
          {...offlineProps(offline)}
          aria-describedby={offline ? `${nameId} ${reasonId}` : nameId}
          onClick={() => onTap(row.id, STATUS.reunited, 'reunite')}
        >
          <Check size={14} strokeWidth={1.75} aria-hidden />
          Reunited
        </Button>
      </div>
      {offline ? <VisuallyHidden id={reasonId}>Needs a connection</VisuallyHidden> : null}
    </Card>
  );
});

export const CheckCard = memo(function CheckCard({ row, now, offline, onTap }: ActionCardProps) {
  const reasonId = useId();
  const nameId = useId();
  const subId = useId();
  const minutes = minutesSince(row.createdAt, now);
  const desc = cardDescription(row);
  const ag = ageGender(row.age, row.gender);
  const sub = `${formatCaseNumber(row.caseNumber)} · ${row.postShort}`;
  const label = `${whoPhrase(row)}. ${sub}. Waiting ${minutesPhrase(minutes)}.${desc ? ` ${desc}` : ''}`;
  const fresh = isFresh(row.createdAt, now);
  const describedBy = offline ? `${nameId} ${subId} ${reasonId}` : `${nameId} ${subId}`;
  return (
    <Card size="2" className={`${s.card} ${fresh ? s.fresh : ''}`} data-testid="check-card">
      <OpenButton id={row.id} label={label} />
      <div aria-hidden>
        <div className={s.qh}>
          <Thumb photoId={row.firstPhotoId} />
          <Who name={displayName(row.name)} ag={ag} sub={sub} nameId={nameId} subId={subId} />
          <WaitBadge minutes={minutes} />
        </div>
        {desc ? (
          <Text as="p" size="2" className={s.qd}>
            {desc}
          </Text>
        ) : null}
      </div>
      <div className={`${s.qa} ${s.actions} ${desc ? '' : s.qaGap}`}>
        <Button
          size="2"
          variant="soft"
          color="gray"
          {...offlineProps(offline)}
          aria-describedby={describedBy}
          onClick={() => onTap(row.id, STATUS.notInMedical, 'answer')}
        >
          <X size={15} strokeWidth={1.75} aria-hidden />
          Not in medical
        </Button>
        <Button
          size="2"
          color="green"
          {...offlineProps(offline)}
          aria-describedby={describedBy}
          onClick={() => onTap(row.id, STATUS.inMedical, 'answer')}
        >
          <Check size={15} strokeWidth={1.75} aria-hidden />
          In medical
        </Button>
      </div>
      {offline ? <VisuallyHidden id={reasonId}>Needs a connection</VisuallyHidden> : null}
    </Card>
  );
});

// ---------------------------------------------------------------------------------------------------
// My requests: MCard (with the progress stepper) and queued requests
// ---------------------------------------------------------------------------------------------------

export const MineCard = memo(function MineCard({ row, now, freshTone }: { row: RequestSummary; now: number; freshTone: string | null }) {
  const meta = statusMeta(row.status);
  const closed = isClosed(row.status);
  const waiting = row.status === STATUS.waiting;
  const minutes = minutesSince(waiting ? row.createdAt : statusSince(row), now);
  const sub = `${formatCaseNumber(row.caseNumber)} · ${row.postShort}`;
  const label = `${whoPhrase(row)}. ${sub}. ${meta.label}${waiting ? `, waiting ${minutesPhrase(minutes)}` : `, ${minutesPhrase(minutes)} ago`}.`;
  return (
    <Card
      size="2"
      className={`${s.card} ${freshTone ? s.fresh : ''}`}
      data-tone={freshTone ?? undefined}
      style={dim(closed)}
      data-testid="mine-card"
    >
      <OpenButton id={row.id} label={label} />
      <div aria-hidden>
        <div className={s.qh}>
          <Thumb photoId={row.firstPhotoId} />
          <Who name={displayName(row.name)} ag={ageGender(row.age, row.gender)} sub={sub} />
          {waiting ? (
            <WaitBadge minutes={minutes} />
          ) : (
            <Text size="1" color="gray" className={s.nowrap}>
              {formatDuration(minutes)}
            </Text>
          )}
        </div>
        <div className={s.stat}>
          <StatusGlyph status={row.status} size={15} />
          <Text size="2" weight="medium" color={labelColor(meta.tone)}>
            {meta.label}
          </Text>
        </div>
        <Stepper model={stepperModel(row.status)} />
      </div>
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
