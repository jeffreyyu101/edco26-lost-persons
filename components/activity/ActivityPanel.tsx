'use client';
// The Activity inbox (design/screens/f34-states.html Activity, f34-v2-2..4 and 9; design/references/
// mobbin-activity-inbox.txt): "Activity" with a ✓✓ Mark all read (disabled when nothing is unread, gone when
// the list is empty), ONE row per request (its latest event), newest first, day labels only when the list
// spans more than one day, and "Nothing new" when empty. Tapping a row opens the request (and marks it read),
// at its Messages when the row's latest event is a message (R2, 2026-11-07);
// the sheet or popover closes. Mark all read shows "3 marked read · Undo" for 5 s.
import { IconButton, VisuallyHidden } from '@radix-ui/themes';
import { CheckCheck } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { activityAriaLabel, activityGlyph, activityLine2, activityTime, groupByDay, type ActivityRow } from '@/lib/activity';
import { activityClient, useActivity } from '@/lib/client/activity-client';
import { navigate } from '@/lib/client/nav';
import { openThread } from '@/lib/client/thread-jump';
import { useEventTimezone, useNow } from '@/lib/client/store-contract';
import { ActivityGlyphIcon } from './glyphs';
import { BellIcon } from './icons';
import s from './activity.module.css';

const UNDO_MS = 5_000;

export interface ActivityPanelProps {
  /** The heading element: the sheet passes its Dialog.Title so the dialog is named by it. */
  heading: (props: { className: string; children: ReactNode }) => ReactNode;
  /** Closes the sheet / popover (a row was opened). */
  onClose: () => void;
  variant: 'sheet' | 'popover';
}

/**
 * One row. Named by its own sentence (activityAriaLabel) in a VisuallyHidden span, the visible parts hidden from
 * screen readers, rather than by aria-label: a message's line ("Rae C.: Bring 1 person only") beside a
 * different aria-label failed axe's label-in-name check (WCAG 2.5.3; F3 + F4 release).
 */
function Row({ row, now, timeZone, onOpen }: { row: ActivityRow; now: number; timeZone: string; onOpen: (row: ActivityRow) => void }) {
  const glyph = activityGlyph(row.kind, row.detail);
  return (
    <button
      type="button"
      className={s.row}
      data-read={row.read ? '' : undefined}
      data-kind={row.kind}
      data-testid="activity-row"
      onClick={() => onOpen(row)}
    >
      <VisuallyHidden>{activityAriaLabel(row, now)}</VisuallyHidden>
      {row.read ? null : <span className={s.dot} aria-hidden />}
      <span className={s.glyph} aria-hidden>
        <ActivityGlyphIcon icon={glyph.icon} tone={glyph.tone} size={18} />
      </span>
      <span className={s.text} aria-hidden>
        <span className={s.line1}>{row.title}</span>
        <span className={s.line2}>{activityLine2(row)}</span>
      </span>
      <span className={s.when} aria-hidden>
        {activityTime(row.at, now, timeZone)}
      </span>
    </button>
  );
}

export function ActivityPanel({ heading, onClose, variant }: ActivityPanelProps) {
  const activity = useActivity();
  const now = useNow();
  const timeZone = useEventTimezone();
  const [undo, setUndo] = useState<{ ids: string[]; until: number } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(undoTimer.current), []);

  const rows = activity.rows ?? [];
  const sections = groupByDay(rows, now, timeZone);
  const empty = activity.rows !== null && rows.length === 0;
  const anyUnread = rows.some((r) => !r.read) || activity.unread > 0;

  const open = (row: ActivityRow) => {
    activityClient().markRead(row.requestId);
    onClose();
    // (R2) A row whose latest event is a message lands at the request's thread; the others at its top.
    if (row.kind === 'message') openThread(row.requestId);
    else navigate({ r: row.requestId });
  };

  const markAll = async () => {
    const ids = await activityClient().markAllRead();
    if (!ids || ids.length === 0) return;
    clearTimeout(undoTimer.current);
    setUndo({ ids, until: Date.now() + UNDO_MS });
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
  };

  const runUndo = () => {
    if (!undo) return;
    clearTimeout(undoTimer.current);
    const ids = undo.ids;
    setUndo(null);
    void activityClient().undoMarkAll(ids);
  };

  return (
    <div className={s.panel} data-testid="activity-panel" data-variant={variant}>
      <div className={s.head}>
        {heading({ className: s.title ?? '', children: 'Activity' })}
        {empty ? null : (
          <IconButton
            variant="ghost"
            color="gray"
            size="3"
            className={`${s.markAll} lp-hit`}
            aria-label="Mark all read"
            disabled={!anyUnread}
            onClick={() => void markAll()}
            data-testid="activity-mark-all"
          >
            <CheckCheck size={20} strokeWidth={2} aria-hidden />
            {/* The tooltip: CSS only, like the desk's (Radix Tooltip would grow the first load, spec A25). */}
            <span className={s.tip} aria-hidden>
              Mark all read
            </span>
          </IconButton>
        )}
      </div>
      {empty ? (
        <div className={s.empty} data-testid="activity-empty">
          <BellIcon size={30} strokeWidth={1.5} />
          Nothing new
        </div>
      ) : activity.rows === null ? (
        <div className={s.empty} aria-busy="true">
          {activity.failed ? 'Needs a connection' : null}
        </div>
      ) : (
        <div className={s.list}>
          {sections.map((section, i) => (
            <div key={section.label ?? i}>
              {section.label ? (
                <div className={s.day} aria-hidden>
                  {section.label}
                </div>
              ) : null}
              {/* One list per day, named by its label (the visible label is decoration for sight). */}
              <div role="list" aria-label={section.label ? `Activity, ${section.label}` : 'Activity'}>
                {section.rows.map((row) => (
                  <div key={row.requestId} role="listitem" className={s.item}>
                    <Row row={row} now={now} timeZone={timeZone} onOpen={open} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {undo ? (
        <div className={s.undo} role="status" aria-live="polite" data-testid="activity-undo">
          <span className={s.undoText}>{undo.ids.length} marked read</span>
          <button type="button" className={s.undoBtn} onClick={runUndo}>
            Undo
          </button>
        </div>
      ) : null}
    </div>
  );
}
