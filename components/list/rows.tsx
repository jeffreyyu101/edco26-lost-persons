'use client';
// Flat rows: All (requests.html LogRow), queued requests on top (states.html Offline) and search results
// (states.html SRow).
import { Text } from '@radix-ui/themes';
import { CircleAlert } from 'lucide-react';
import { memo } from 'react';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import type { OutboxItem, RequestSummary } from '@/lib/api-types';
import { navigate } from '@/lib/client/nav';
import type { SearchHit } from '@/lib/client/selectors';
import { ageGender, statusMeta } from '@/lib/domain';
import { formatCaseNumber } from '@/lib/format';
import {
  displayName,
  highlightParts,
  isClosed,
  labelColor,
  outboxDisplay,
  outboxRowLabel,
  rowLabel,
  searchDisplay,
  searchRowLabel,
  type Ranges,
} from './list-helpers';
import s from './list.module.css';

export function Highlight({ text, ranges }: { text: string; ranges: Ranges }) {
  if (ranges.length === 0) return <>{text}</>;
  return (
    <>
      {highlightParts(text, ranges).map((part, i) =>
        part.hit ? (
          <mark key={i} className={s.mark}>
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

// The {' '} between the text pieces of a row render nothing (white space between flex items is dropped);
// they keep the pieces apart as words, so the row's text reads "Kayla Martinez 19 F 10:58 …" and its
// aria-label can start with exactly that (WCAG 2.5.3).

/** One request in All: glyph · name, age/sex · time / status label · post · LP number. */
export const RequestRow = memo(function RequestRow({ row, time }: { row: RequestSummary; time: string }) {
  const meta = statusMeta(row.status);
  const ag = ageGender(row.age, row.gender);
  return (
    <button
      type="button"
      className={`${s.row} ${isClosed(row.status) ? s.muted : ''}`}
      data-request-id={row.id}
      aria-label={rowLabel(row, time)}
      onClick={() => navigate({ r: row.id })}
    >
      <span className={s.g}>
        <StatusGlyph status={row.status} />
      </span>
      <span className={s.rm}>
        <span className={s.l1}>
          <Text size="2" weight="medium">
            {displayName(row.name)}
          </Text>{' '}
          {ag ? (
            <Text size="2" color="gray" className={s.nowrap}>
              {ag}
            </Text>
          ) : null}{' '}
          <span className={s.sp} />
          <span className={s.t}>{time}</span>
        </span>{' '}
        <span className={s.l2}>
          <Text size="1" weight="medium" color={labelColor(meta.tone)} className={s.nowrap}>
            {meta.label}
          </Text>{' '}
          <span className={s.meta}>
            · {row.postShort} · {formatCaseNumber(row.caseNumber)}
          </span>
        </span>
      </span>
    </button>
  );
});

/**
 * A request saved on this phone and not sent yet: dashed glyph, "Waiting to send" and "Not sent" where the
 * LP number goes. A "Needs attention" item (rejected by the server) opens its editor.
 */
export function OutboxRow({ item, time }: { item: OutboxItem; time: string }) {
  const d = outboxDisplay(item);
  const label = outboxRowLabel(d, time);
  const content = (
    <>
      <span className={s.g}>
        {d.needsAttention ? (
          <CircleAlert size={14} strokeWidth={2.25} className={s.attention} aria-hidden />
        ) : (
          <StatusGlyph kind="queued" />
        )}
      </span>
      <span className={s.rm}>
        <span className={s.l1}>
          <Text size="2" weight="medium">
            {d.name}
          </Text>{' '}
          {d.ageGender ? (
            <Text size="2" color="gray" className={s.nowrap}>
              {d.ageGender}
            </Text>
          ) : null}{' '}
          <span className={s.sp} />
          <span className={s.t}>{time}</span>
        </span>{' '}
        <span className={s.l2}>
          <Text size="1" weight="medium" color={d.needsAttention ? 'red' : undefined} className={s.nowrap}>
            {d.label}
          </Text>{' '}
          <span className={s.meta}>
            · {d.post} · {d.caseText}
          </span>
        </span>
      </span>
    </>
  );
  if (d.needsAttention) {
    return (
      <button
        type="button"
        className={s.row}
        data-outbox-id={item.mutationId}
        aria-label={label}
        onClick={() => navigate({ outbox: item.mutationId })}
      >
        {content}
      </button>
    );
  }
  return (
    <div className={s.row} data-outbox-id={item.mutationId} role="group" aria-label={label}>
      {content}
    </div>
  );
}

/** A search result: name (highlighted on a name hit) · LP number, the matched text, the status. */
export const SearchRow = memo(function SearchRow({ hit }: { hit: SearchHit }) {
  const { row } = hit;
  const meta = statusMeta(row.status);
  const d = searchDisplay(hit);
  const ag = ageGender(row.age, row.gender);
  const lp = formatCaseNumber(row.caseNumber);
  return (
    <button
      type="button"
      className={`${s.row} ${isClosed(row.status) ? s.muted : ''}`}
      data-request-id={row.id}
      aria-label={searchRowLabel(row, d.line)}
      onClick={() => navigate({ r: row.id })}
    >
      <span className={s.g}>
        <StatusGlyph status={row.status} />
      </span>
      <span className={s.rm}>
        <span className={s.l1}>
          <Text size="2" weight="medium">
            <Highlight text={displayName(row.name)} ranges={row.name ? d.nameRanges : []} />
          </Text>{' '}
          {ag ? (
            <Text size="2" color="gray" className={s.nowrap}>
              {ag}
            </Text>
          ) : null}{' '}
          <span className={s.sp} />
          <span className={s.t}>
            <Highlight text={lp} ranges={d.caseRanges} />
          </span>
        </span>{' '}
        {d.line ? (
          <span className={s.desc}>
            <Highlight text={d.line} ranges={d.lineRanges} />
          </span>
        ) : null}{' '}
        <span className={s.l2}>
          <Text size="1" weight="medium" color={labelColor(meta.tone)} className={s.nowrap}>
            {meta.label}
          </Text>
        </span>
      </span>
    </button>
  );
});
