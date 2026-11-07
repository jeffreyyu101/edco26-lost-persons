'use client';
// The audit trail list (profile.html `.tl`): newest first, a status glyph (or a dot) on the timeline, the
// change, then "who · when". Items come from buildAuditTrail() (audit-trail.ts).
import { Skeleton, Text, VisuallyHidden } from '@radix-ui/themes';
import { StageGlyph } from '@/components/ui/StageGlyph';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import { statusMeta } from '@/lib/domain';
import type { AuditItem } from './audit-trail';
import s from './profile.module.css';

function StatusLine({ change }: { change: NonNullable<AuditItem['status']> }) {
  const tone = change.toTone ?? statusMeta(change.to).tone;
  return (
    <div className={s.chg}>
      {change.from ? (
        <>
          {change.fromGlyph ? <StageGlyph glyph={change.fromGlyph} size={12} /> : <StatusGlyph status={change.from} size={12} />}
          <Text size="2" weight="medium">
            {change.fromLabel}
          </Text>
          <span className={s.arr} aria-hidden>
            →
          </span>
          <VisuallyHidden>to</VisuallyHidden>
        </>
      ) : null}
      {change.toGlyph ? <StageGlyph glyph={change.toGlyph} size={12} /> : <StatusGlyph status={change.to} size={12} />}
      <Text size="2" weight="medium" color={tone}>
        {change.toLabel}
      </Text>
    </div>
  );
}

function Item({ item }: { item: AuditItem }) {
  const byline = [item.who, item.when].filter(Boolean).join(' · ');
  return (
    <li data-testid="audit-item">
      <span className={s.d}>
        {item.status ? (
          item.status.toGlyph ? (
            <StageGlyph glyph={item.status.toGlyph} />
          ) : (
            <StatusGlyph status={item.status.to} />
          )
        ) : (
          <span className={s.pt} />
        )}
      </span>
      <div className={s.tt}>
        {item.status ? (
          <StatusLine change={item.status} />
        ) : (
          <Text size="2" weight="medium">
            {item.title}
          </Text>
        )}
        {item.changes.map((c, i) => (
          <div key={i} className={s.chgSm}>
            {item.labelChanges ? <span className={s.chgLabel}>{c.label}</span> : null}
            <VisuallyHidden>{item.labelChanges ? '' : c.label} changed from</VisuallyHidden>
            <s className={s.old}>{c.from}</s>
            <span className={s.arr} aria-hidden>
              →
            </span>
            <VisuallyHidden>to</VisuallyHidden>
            <span>{c.to}</span>
          </div>
        ))}
        {item.note ? (
          <Text size="1" color="gray">
            {item.note}
          </Text>
        ) : null}
        {item.notes ? (
          <Text size="1" color="gray" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {item.notes}
          </Text>
        ) : null}
        {byline ? (
          <Text size="1" color="gray">
            {byline}
          </Text>
        ) : null}
      </div>
    </li>
  );
}

export function AuditTrail({ items }: { items: readonly AuditItem[] }) {
  return (
    <ol className={s.tl} aria-label="Audit trail" data-testid="audit-trail">
      {items.map((item) => (
        <Item key={item.key} item={item} />
      ))}
    </ol>
  );
}

/** Placeholder rows while the detail loads (skeletons.html shapes). */
export function AuditTrailSkeleton() {
  return (
    <ol className={s.tl} aria-hidden="true">
      {[62, 48, 56].map((w, i) => (
        <li key={i}>
          <span className={s.d}>
            <span className={s.pt} style={{ background: 'var(--gray-a6)' }} />
          </span>
          <div className={s.tt} style={{ flex: 1, gap: 6, paddingTop: 2 }}>
            <Skeleton height="13px" width={`${w}%`} />
            <Skeleton height="10px" width={`${w - 14}%`} />
          </div>
        </li>
      ))}
    </ol>
  );
}
