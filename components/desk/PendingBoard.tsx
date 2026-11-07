'use client';
// Pending on the desk (from 768 px; Pending v9.1, Brian 2026-11-06 19:35–20:40, design/screens/pending-v9.html
// frames 4 and 5): a two-column board, Waiting for check | Friend coming, with the phone's cards and headers
// (glyph, label, count, chevron: one tap folds a column, with the phone's fold memory). Each column scrolls on
// its own under the top bar. No Later lane and no SegmentedControl: when the main column is too narrow for two
// card columns (a request docked beside it on a small laptop) the board stacks the two sections in one column,
// as the phone does. CSS container queries pick the layout (no measuring), so J / K move through every card on
// screen, Waiting for check first.
import { PendingQueues, type PendingQueuesProps } from '@/components/list/PendingQueues';
import b from './pending-board.module.css';

export type PendingBoardProps = Omit<PendingQueuesProps, 'variant' | 'boardClasses'>;

export function PendingBoard(props: PendingBoardProps) {
  return (
    <div className={b.board} data-testid="pending-board">
      <div className={b.cols}>
        <PendingQueues {...props} variant="board" boardClasses={{ col: b.col, cards: b.cards }} />
      </div>
    </div>
  );
}
