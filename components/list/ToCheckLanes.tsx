'use client';
// (F5) Pending > To check with the "Not found yet" hold (design/screens/updates.html #recheck, recheck-2.png):
// due rechecks first (full cards with a blue "Recheck" chip), then the normal queue, then a "Later N" divider
// (hourglass) over compact rows of held requests not due yet: initials, age / sex, and the recheck time. A
// Later row opens the request. The phone's Pending tab and the desk's To check column both render this.
import { Hourglass, RefreshCw } from 'lucide-react';
import { memo } from 'react';
import type { RequestSummary } from '@/lib/api-types';
import type { ToCheckLanes } from '@/lib/client/selectors';
import { navigate } from '@/lib/client/nav';
import { STAGE_META, ageGender } from '@/lib/domain';
import { formatCaseNumber, formatClockAmPm } from '@/lib/format';
import { CheckCard, type CheckCardProps } from './cards';
import { displayName, whoPhrase } from './list-helpers';
import s from './list.module.css';

export interface ToCheckListProps extends Pick<CheckCardProps, 'now' | 'offline' | 'onNotInMedical' | 'onInMedical' | 'timeZone'> {
  lanes: ToCheckLanes;
}

export function ToCheckList({ lanes, now, offline, onNotInMedical, onInMedical, timeZone }: ToCheckListProps) {
  const card = (row: RequestSummary, recheck: boolean) => (
    <CheckCard
      key={row.id}
      row={row}
      now={now}
      offline={offline}
      recheck={recheck}
      timeZone={timeZone}
      onNotInMedical={onNotInMedical}
      onInMedical={onInMedical}
    />
  );
  return (
    <>
      {lanes.due.map((row) => card(row, true))}
      {lanes.queue.map((row) => card(row, false))}
      {lanes.later.length > 0 ? <LaterGroup rows={lanes.later} timeZone={timeZone} /> : null}
    </>
  );
}

/** "⌛ Later 2 ———" and the held requests under it, the earliest recheck first. */
export function LaterGroup({ rows, timeZone }: { rows: readonly RequestSummary[]; timeZone?: string }) {
  return (
    <section className={s.laterGroup} aria-label={`Later, ${rows.length} on hold`} data-testid="later-group">
      <div className={s.later} aria-hidden>
        <Hourglass size={14} strokeWidth={2} />
        <span>Later</span>
        <span className={s.laterN}>{rows.length}</span>
        <span className={s.laterRule} />
      </div>
      {rows.map((row) => (
        <LaterRow key={row.id} row={row} timeZone={timeZone} />
      ))}
    </section>
  );
}

/** One held request: "K.T.  19 F  ⟳ 4:40 PM". The whole row opens it. */
export const LaterRow = memo(function LaterRow({ row, timeZone }: { row: RequestSummary; timeZone?: string }) {
  const at = row.recheckAt ? formatClockAmPm(row.recheckAt, timeZone) : '';
  const ag = ageGender(row.age, row.gender);
  const label = `${whoPhrase(row)}. ${STAGE_META.notFoundYet.label}, recheck at ${at}. ${row.postShort} · ${formatCaseNumber(row.caseNumber)}.`;
  return (
    <button
      type="button"
      className={s.crow}
      data-request-id={row.id}
      data-testid="later-row"
      aria-label={label}
      onClick={() => navigate({ r: row.id })}
    >
      <span className={s.crowNm} aria-hidden>
        {displayName(row.name)}
      </span>
      {ag ? (
        <span className={s.crowAs} aria-hidden>
          {ag}
        </span>
      ) : null}
      <span className={s.crowAt} aria-hidden>
        <RefreshCw size={14} strokeWidth={2} />
        {at}
      </span>
    </button>
  );
});
