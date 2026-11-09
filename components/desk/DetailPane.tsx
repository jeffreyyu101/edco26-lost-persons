'use client';
// The detail pane (design/screens/desktop-log.html .panel): the request beside the list. Its header is
// the LP number, previous / next (K / J) through the main column's order, the ⋯ menu (the profile's own
// items: Edit details, Mark discharged / Reopen, Cancel request) and close (Esc). The profile below it is
// the phone's (ProfileView presentation="panel", which hides its own top bar). The open row stays
// highlighted in the list.
import { AlertDialog, Button, DropdownMenu, IconButton, Text } from '@radix-ui/themes';
import { Check, ChevronDown, ChevronUp, Ellipsis, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RequestSummary } from '@/lib/api-types';
import { goBack, navigate, parseView, viewToParams } from '@/lib/client/nav';
import { useActions, useConnection, useRequest, useSession, type MutationResult } from '@/lib/client/store-contract';
import { canCancel, menuActions, sameStaff, type StatusAction } from '@/lib/domain';
import { CompanionMenuItems } from '@/components/profile/CompanionSheets';
import { swapCancelState } from '@/lib/client/swap';
import { formatCaseNumber } from '@/lib/format';
import { MAIN_SELECTOR, readRowIds, rowElement } from './keyboard';
import { Tip } from './parts';
import { PANE_FALLBACK_LABEL, neighbours } from './nav-model';
import { isMainView, paneRequestId, type MainView } from './views';
import d from './desk.module.css';

export interface DeskPaneProps {
  /** The open request (?r=). */
  id: string;
  /** The view in the main column (where close returns to on a deep link). */
  main: MainView;
  /** The profile: <ProfileView id={id} presentation="panel" />. */
  children: ReactNode;
}

/** The address the last close left from (history.back() lands a moment later). */
let closingFrom: string | null = null;
/** The request the last close (Esc or ×) closed, until the shell's focus return takes it. */
let closedId: string | null = null;
/** Whether each history entry the desk has seen (by depth) shows a list or the dashboard. */
const mainAtDepth = new Map<number, boolean>();

/** The current entry's in-app depth (lib/client/nav.ts keeps it in history.state.lpDepth; 0 = opened on). */
function historyDepth(): number {
  const depth = (window.history.state as { lpDepth?: unknown } | null)?.lpDepth;
  return typeof depth === 'number' ? depth : 0;
}

/** Note what the current history entry shows (DeskKeys calls it whenever the address changes). */
export function noteHistoryEntry(): void {
  mainAtDepth.set(historyDepth(), isMainView(parseView(new URLSearchParams(window.location.search))));
}

/** Forget the entries noted (the desk unmounted: the phone may change them unseen). */
export function forgetHistoryEntries(): void {
  mainAtDepth.clear();
}

/**
 * Close the pane: back to the list it was opened from, or the main view on a deep link. Back past every
 * request opened over it with a new entry (a dashboard row; list rows open in place, see DeskKeys), so
 * one close always closes. An entry the desk has not seen (before a reload) ends the walk: one Back.
 */
export function closePane(main: MainView): void {
  // A second close before Back lands (a double click, Esc then ×) must not go back twice.
  if (closingFrom === window.location.href) return;
  closingFrom = window.location.href;
  // From the address bar, not a render: J / K and ↑ / ↓ replace it a moment before React catches up.
  closedId = paneRequestId(parseView(new URLSearchParams(window.location.search)));
  const depth = historyDepth();
  for (let k = depth - 1; k >= 0; k -= 1) {
    const isMain = mainAtDepth.get(k);
    if (isMain === undefined) break;
    if (isMain) {
      window.history.go(k - depth);
      return;
    }
    if (k === 0) {
      // Requests and forms all the way down to a deep link: show the main view here instead.
      navigate(viewToParams(main), { replace: true });
      return;
    }
  }
  goBack(viewToParams(main));
}

/** The request closed by closePane since the last call, once (null after Back or a close by other means). */
export function takeClosedPane(): string | null {
  const id = closedId;
  closedId = null;
  return id;
}

/** Open another request in the pane (replaces the entry: Back still returns to the list). */
export function openInPane(id: string): void {
  navigate({ r: id }, { replace: true });
  rowElement(id)?.scrollIntoView({ block: 'nearest' });
}

/** The main column's request ids in order, kept current as the list changes. */
function useRowIds(): string[] {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    const main = document.querySelector(MAIN_SELECTOR);
    if (!main) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const next = readRowIds(main);
      setIds((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-request-id', 'class', 'hidden'] });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return ids;
}

/**
 * The open row's highlight (the row is the list's; a request id is a validated UUID). The mockup's gray-a3
 * tint in dark; gray-a2 in light, where gray-a3 takes the blue status text under 4.5:1.
 */
function selectedRowCss(id: string): string {
  const sel = `${MAIN_SELECTOR} [data-request-id="${id}"]`;
  return `${sel}{background-color:var(--gray-a2);box-shadow:inset 2px 0 0 var(--gray-12)}.dark ${sel}{background-color:var(--gray-a3)}`;
}

export function DeskPane({ id, main, children }: DeskPaneProps) {
  const row = useRequest(id);
  const ids = useRowIds();
  const { prev, next } = neighbours(ids, id);
  const label = row ? formatCaseNumber(row.caseNumber) : PANE_FALLBACK_LABEL;
  const bodyRef = useRef<HTMLDivElement>(null);

  // Each request starts at its top (the pane scrolls on its own; the list keeps its place). A request
  // (re)opened here can be closed again.
  useEffect(() => {
    bodyRef.current?.scrollTo(0, 0);
    closingFrom = null;
    closedId = null;
  }, [id]);

  return (
    <section className={d.pane} aria-label={label} data-testid="desk-pane" data-request={id}>
      <style>{selectedRowCss(id)}</style>
      <header className={d.ph}>
        <span className={d.pid} data-testid="desk-pane-case">
          {label}
        </span>
        <PaneButton label="Previous request" hint="K" keys="K ArrowUp" disabled={!prev} onClick={() => prev && openInPane(prev)} testId="desk-prev">
          <ChevronUp size={17} strokeWidth={1.75} aria-hidden />
        </PaneButton>
        <PaneButton label="Next request" hint="J" keys="J ArrowDown" disabled={!next} onClick={() => next && openInPane(next)} testId="desk-next">
          <ChevronDown size={17} strokeWidth={1.75} aria-hidden />
        </PaneButton>
        <span className={d.sp} />
        <PaneMenu row={row} label={label} />
        <PaneButton label="Close" hint="Esc" keys="Escape" onClick={() => closePane(main)} testId="desk-close" end>
          <X size={17} strokeWidth={1.75} aria-hidden />
        </PaneButton>
      </header>
      <div className={d.pbody} ref={bodyRef}>
        {children}
      </div>
    </section>
  );
}

function PaneButton({
  label,
  hint,
  keys,
  disabled = false,
  onClick,
  testId,
  end = false,
  children,
}: {
  label: string;
  hint: string;
  keys: string;
  disabled?: boolean;
  /** The last button: its tooltip lines up with its right edge. */
  end?: boolean;
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <IconButton
      variant="ghost"
      color="gray"
      className={d.ib}
      aria-label={label}
      aria-keyshortcuts={keys}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      {children}
      <Tip below end={end}>{`${label} (${hint})`}</Tip>
    </IconButton>
  );
}

// ---------------------------------------------------------------------------------------------------
// ⋯ menu: the profile's own items (its top bar is hidden in the pane)
// ---------------------------------------------------------------------------------------------------

const NEEDS_CONNECTION = 'Needs a connection';

type CancelState = { busy: boolean; error: string | null };

/** The profile's cancel failure copy (components/profile/ProfileView.tsx failureMessage). */
export function cancelFailureMessage(result: Extract<MutationResult, { ok: false }>): string {
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

function PaneMenu({ row, label }: { row: RequestSummary | null; label: string }) {
  const actions = useActions();
  const session = useSession();
  const { connection } = useConnection();
  const offline = connection === 'offline';
  const [cancelState, setCancelState] = useState<CancelState | null>(null);
  const cancellable = row ? canCancel(row.status, row.createdBy, session.staff) : false;
  // As in the profile: the confirm closes if the request stops being cancellable while it is open.
  if (cancelState && !cancellable && !cancelState.busy && cancelState.error === null) setCancelState(null);

  const trigger = (
    <IconButton variant="ghost" color="gray" className={d.ib} aria-label="More actions" disabled={!row} data-testid="desk-more">
      <Ellipsis size={18} strokeWidth={1.75} aria-hidden />
    </IconButton>
  );
  if (!row) return trigger;

  const isCreator = sameStaff(row.createdBy, session.staff);
  const menu = menuActions(row.status, isCreator);
  const setStatus = (a: StatusAction) => void actions.setStatus(row.id, a.to, a.kind);
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
    else setCancelState({ busy: false, error: cancelFailureMessage(result) });
  };

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>{trigger}</DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" variant="soft">
          <DropdownMenu.Item onSelect={() => navigate({ r: row.id, edit: 'all' })}>
            <Pencil size={15} aria-hidden />
            Edit details
          </DropdownMenu.Item>
          <CompanionMenuItems
            status={row.status}
            offline={offline}
            onSend={(to, kind) => void actions.setStatus(row.id, to, kind)}
            swapCancel={swapCancelState(row)}
            onCancelSwap={() => void actions.swap(row.id, { action: 'cancel' })}
          />
          {menu.map((a) => (
            <DropdownMenu.Item key={a.id} disabled={offline} onSelect={() => setStatus(a)}>
              {a.id === 'discharge' ? <Check size={15} aria-hidden /> : <RotateCcw size={15} aria-hidden />}
              {a.label}
            </DropdownMenu.Item>
          ))}
          {cancellable ? (
            <>
              <DropdownMenu.Separator />
              <DropdownMenu.Item color="red" onSelect={() => setCancelState({ busy: false, error: null })}>
                <Trash2 size={15} aria-hidden />
                Cancel request
              </DropdownMenu.Item>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      <AlertDialog.Root
        open={cancelState !== null}
        onOpenChange={(open) => {
          if (!open && !cancelState?.busy) setCancelState(null);
        }}
      >
        <AlertDialog.Content maxWidth="342px" style={{ padding: 20 }}>
          <AlertDialog.Title size="4" weight="medium" mb="1">
            Cancel this request?
          </AlertDialog.Title>
          <AlertDialog.Description size="2" color="gray">
            {[label, row.name].filter(Boolean).join(' · ')}
          </AlertDialog.Description>
          {cancelState?.error ? (
            <Text as="p" role="alert" size="2" color="red" mt="2" mb="0">
              {cancelState.error}
            </Text>
          ) : null}
          <div className={d.btns}>
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
    </>
  );
}
