'use client';
// Pending on the desk (from 768 px; design/screens/pending-v8.html "Desktop", pending-v8-5.png): the two
// queues side by side in the shell's main column, To check | Friend coming, with the phone's cards. When the
// main column is too narrow for two card columns (an iPad in portrait at 768, or a request docked beside the
// list on a small laptop), the board falls back to the phone's segmented control and shows one queue at a
// time. Both columns are always rendered (CSS container queries pick the layout, no measuring), so J / K
// move through every card that is on screen, To check first.
import type { ReactNode } from 'react';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import type { RequestSummary } from '@/lib/api-types';
import { ComingCard, type CheckCardProps, type ComingCardProps } from '@/components/list/cards';
import { LaterGroup, ToCheckList } from '@/components/list/ToCheckLanes';
import type { ToCheckLanes } from '@/lib/client/selectors';
import { PendingTabs, pendingTabIds, type PendingTab } from '@/components/list/PendingTabs';
import b from './pending-board.module.css';

export interface PendingBoardProps {
  waiting: readonly RequestSummary[];
  /** (F5) To check's lanes (due rechecks, the queue, Later). Without them, `waiting` as one queue. */
  lanes?: ToCheckLanes;
  /** (F5) The event timezone, for the recheck times. */
  timeZone?: string;
  friendComing: readonly RequestSummary[];
  now: number;
  offline: boolean;
  /** The segmented control's tab, for when the columns stack. */
  tab: PendingTab;
  onTab: (tab: PendingTab) => void;
  /** useId() of the view (tab and column ids). */
  idBase: string;
  onNotInMedical: CheckCardProps['onNotInMedical'];
  onInMedical: CheckCardProps['onInMedical'];
  onReunited: ComingCardProps['onReunited'];
  onLocate: ComingCardProps['onLocate'];
}

export function PendingBoard(props: PendingBoardProps) {
  const { waiting, friendComing, now, offline, tab, onTab, idBase } = props;
  const lanes: ToCheckLanes = props.lanes ?? { due: [], queue: [...waiting], later: [] };
  const checkCount = lanes.due.length + lanes.queue.length;
  return (
    <div className={b.board} data-testid="pending-board" data-tab={tab}>
      <PendingTabs className={b.tabs} tab={tab} onChange={onTab} counts={{ check: checkCount, coming: friendComing.length }} idBase={idBase} />
      <div className={b.cols}>
        <Column
          id="check"
          idBase={idBase}
          active={tab === 'check'}
          label="To check"
          count={checkCount}
          empty="Nothing to check"
          after={lanes.later.length > 0 ? <LaterGroup rows={lanes.later} timeZone={props.timeZone} /> : null}
        >
          <ToCheckList
            lanes={{ ...lanes, later: [] }}
            now={now}
            timeZone={props.timeZone}
            offline={offline}
            onNotInMedical={props.onNotInMedical}
            onInMedical={props.onInMedical}
          />
        </Column>
        <Column id="coming" idBase={idBase} active={tab === 'coming'} label="Friend coming" count={friendComing.length} empty="No friends coming">
          {friendComing.map((row) => (
            <ComingCard key={row.id} row={row} now={now} offline={offline} onReunited={props.onReunited} onLocate={props.onLocate} />
          ))}
        </Column>
      </div>
    </div>
  );
}

function Column({
  id,
  idBase,
  active,
  label,
  count,
  empty,
  children,
  after = null,
}: {
  id: PendingTab;
  idBase: string;
  active: boolean;
  label: string;
  count: number;
  empty: string;
  children: ReactNode;
  /** (F5) Under the cards, or under the empty note: To check's Later group. */
  after?: ReactNode;
}) {
  const ids = pendingTabIds(idBase, id);
  const headingId = `${ids.panel}-h`;
  return (
    <section
      className={b.col}
      id={ids.panel}
      aria-labelledby={headingId}
      data-col={id}
      data-active={active ? '' : undefined}
      data-testid={`pending-column-${id}`}
    >
      <h2 className={b.colh} id={headingId}>
        <StatusGlyph kind={id === 'check' ? 'waiting' : 'inMedical'} size={14} />
        {label}{' '}
        <span className={b.n}>{count}</span>
      </h2>
      {count > 0 ? <div className={b.cards}>{children}</div> : <p className={b.empty}>{empty}</p>}
      {after}
    </section>
  );
}
