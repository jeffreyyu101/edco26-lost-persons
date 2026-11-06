'use client';
// Where medical has the patient (Pending v8, Dani + Brian 2026-11-06 afternoon; design/screens/pending-v8.html
// "Answering In medical"). One optional free-text field, "Chair 14", saved with the store's
// setMedicalLocation (PATCH {medicalLocation}, audited like any edit). Used right after an In medical tap
// (Skip / Save) and to edit it later from a Friend coming card or the request's status block (Cancel / Save).
//
//   phone (< 768)  a bottom sheet: the green "B.W. is in medical" line, the field (focused, normal keyboard),
//                  Skip / Save. Skip, a tap on the scrim, Esc or a swipe down closes it with nothing saved.
//   desk (≥ 768)   the same form in a small popover pointing at the card (or the location row).
//
// The save is optimistic (the store overlays the new value at once and toasts a failure), so the editor
// closes on Save. Offline, Save waits: answers and edits need a connection. While it is open the Undo bar's
// countdown is held (store holdUndo); it restarts in full when the editor closes.
import { Popover } from '@radix-ui/themes';
import { CloudOff } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject, type TouchEvent } from 'react';
import { Sheet, SheetTitle } from '@/components/ui/Sheet';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import { useActions, useConnection } from '@/lib/client/store-contract';
import { LIMITS } from '@/lib/domain';
import s from './location.module.css';

export interface LocationTarget {
  /** The request. */
  id: string;
  /** The name as the card shows it ("B.W."), for the heading. */
  name: string;
  /** 'answer': straight after In medical (Skip). 'edit': from the location chip or row (Cancel). */
  mode: 'answer' | 'edit';
  /** The location saved now ('' when none): the field starts with it. */
  initial: string;
}

/** What the desk popover points at: a live element when there is one, else the last rect it had. */
export interface Measurable {
  getBoundingClientRect(): DOMRect;
}

export interface LocationEditorProps {
  target: LocationTarget | null;
  /** From 768 px: the popover. Below: the bottom sheet. */
  desk: boolean;
  /** Desk: what the popover points at (see anchorFor). */
  anchor?: RefObject<Measurable | null>;
  /**
   * Desk: where the focus goes when the popover closes with Esc, Skip, Cancel or Save (the chip that opened
   * it, the next card to check), if anywhere. Not after a click or focus outside it.
   */
  returnFocus?: () => HTMLElement | null;
  onClose: () => void;
}

/** A field placeholder, not a caption: medical write bed and beach-chair numbers here (Dani, 14:12). */
const PLACEHOLDER = 'Bed or chair';
/** A swipe down this far (px) closes the sheet, like the native ones. */
const SWIPE_CLOSE_PX = 64;

/**
 * A stand-in element for the desk popover: the first visible element matching `selector` each time the
 * popover measures it, else where that element (or `fallback`, the tapped card) last was. A card answered
 * In medical leaves To check for the end of Friend coming, often off screen: the popover stays where the
 * tap was, and moves with the page when it scrolls (the document is the scroller on the desk too).
 */
export function anchorFor(selector: string, fallback: DOMRect | null): RefObject<Measurable | null> {
  const scroll = () => (typeof window === 'undefined' ? { x: 0, y: 0 } : { x: window.scrollX, y: window.scrollY });
  let last = fallback ? { rect: fallback, at: scroll() } : null;
  return {
    current: {
      getBoundingClientRect() {
        if (typeof document !== 'undefined') {
          for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
            if (el.getClientRects().length === 0) continue;
            last = { rect: el.getBoundingClientRect(), at: scroll() };
            return last.rect;
          }
        }
        if (!last) return new DOMRect(0, 0, 0, 0);
        const now = scroll();
        const { rect, at } = last;
        return new DOMRect(rect.x - (now.x - at.x), rect.y - (now.y - at.y), rect.width, rect.height);
      },
    },
  };
}

export function LocationEditor({ target, desk, anchor, returnFocus, onClose }: LocationEditorProps) {
  if (!target) return null;
  // Keyed: a new target starts from its own saved value.
  const key = `${target.id}:${target.mode}`;
  return desk ? (
    <DeskPopover key={key} target={target} anchor={anchor} returnFocus={returnFocus} onClose={onClose} />
  ) : (
    <PhoneSheet key={key} target={target} onClose={onClose} />
  );
}

/** The form both presentations share: the in-medical line (the dialog's title), the field, two buttons. */
function useLocationForm(target: LocationTarget, onClose: () => void) {
  const actions = useActions();
  const { connection } = useConnection();
  const offline = connection === 'offline';
  const [value, setValue] = useState(target.initial);
  // The sheet's scrim covers the Undo bar: the answer's Undo doesn't run out while this is open, and gets
  // its full 10 s once it closes (DECISIONS: saving the location keeps the answer's Undo usable).
  useEffect(() => actions.holdUndo(), [actions]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (offline) return;
    const next = value.trim() || null;
    onClose();
    if (next !== (target.initial.trim() || null)) void actions.setMedicalLocation(target.id, next);
  };
  return { offline, value, setValue, submit };
}

interface FormProps {
  target: LocationTarget;
  onClose: () => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** The sheet names itself with its dialog title; the popover points aria-labelledby at this id. */
  titleId?: string;
}

function Form({ target, onClose, inputRef, titleId }: FormProps) {
  const { offline, value, setValue, submit } = useLocationForm(target, onClose);
  const reasonId = useId();
  const title = (
    <>
      <StatusGlyph kind="inMedical" size={20} />
      <span className={s.doneText}>{`${target.name} is in medical`}</span>
    </>
  );
  return (
    <form className={s.form} onSubmit={submit} data-testid="location-form">
      {titleId ? (
        <h2 className={s.done} id={titleId} data-testid="location-title">
          {title}
        </h2>
      ) : (
        <SheetTitle className={s.done} data-testid="location-title">
          {title}
        </SheetTitle>
      )}
      <input
        ref={inputRef}
        className={s.field}
        type="text"
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        // Radix focuses the first field when it opens; autoFocus covers a remount.
        autoFocus
        aria-label="Location"
        placeholder={PLACEHOLDER}
        maxLength={LIMITS.medicalLocation}
        enterKeyHint="done"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby={offline ? reasonId : undefined}
      />
      {offline ? (
        <span className={s.offline} id={reasonId}>
          <CloudOff size={13} aria-hidden />
          Needs a connection
        </span>
      ) : null}
      <div className={s.acts}>
        <button type="button" className={`${s.btn} ${s.ghost}`} onClick={onClose}>
          {target.mode === 'answer' ? 'Skip' : 'Cancel'}
        </button>
        <button type="submit" className={`${s.btn} ${s.solid}`} aria-disabled={offline || undefined} data-disabled={offline ? '' : undefined}>
          Save
        </button>
      </div>
    </form>
  );
}

function PhoneSheet({ target, onClose }: { target: LocationTarget; onClose: () => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const sheetOf = () => wrap.current?.closest<HTMLElement>('.lp-sheet') ?? null;

  // Swipe down anywhere but the field closes it (Skip). The sheet follows the finger until it lets go.
  const onTouchStart = (e: TouchEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('input') || e.touches.length !== 1) return;
    drag.current = { y: e.touches[0]!.clientY, dy: 0 };
  };
  const onTouchMove = (e: TouchEvent) => {
    const d = drag.current;
    const sheet = sheetOf();
    if (!d || !sheet) return;
    d.dy = Math.max(0, e.touches[0]!.clientY - d.y);
    sheet.style.transform = d.dy > 0 ? `translateY(${d.dy}px)` : '';
    sheet.style.transition = 'none';
  };
  const onTouchEnd = () => {
    const d = drag.current;
    drag.current = null;
    const sheet = sheetOf();
    if (!d || !sheet) return;
    sheet.style.transition = '';
    if (d.dy >= SWIPE_CLOSE_PX) {
      onClose();
      return;
    }
    sheet.style.transform = '';
  };

  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())} titleInContent>
      <div
        ref={wrap}
        className={s.sheetBody}
        data-location-sheet=""
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <Form target={target} onClose={onClose} />
      </div>
    </Sheet>
  );
}

function DeskPopover({
  target,
  anchor,
  returnFocus,
  onClose,
}: {
  target: LocationTarget;
  anchor?: RefObject<Measurable | null>;
  returnFocus?: () => HTMLElement | null;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const fallback = useMemo(() => anchorFor('[data-none]', null), []);
  // Closed by a click or focus elsewhere: the focus stays where the person put it.
  const leftOutside = useRef(false);
  // A popover opened from a tap: the field takes the focus (Radix focuses the content itself first).
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <Popover.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Popover.Anchor virtualRef={anchor ?? fallback} />
      <Popover.Content
        side="bottom"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        width="320px"
        maxWidth="calc(100vw - 24px)"
        className={s.pop}
        updatePositionStrategy="always"
        onInteractOutside={() => {
          leftOutside.current = true;
        }}
        onCloseAutoFocus={(e) => {
          if (leftOutside.current) return;
          const el = returnFocus?.();
          if (!el) return;
          e.preventDefault();
          el.focus({ preventScroll: true });
        }}
        aria-labelledby={titleId}
        data-location-popover=""
      >
        <Form target={target} onClose={onClose} inputRef={inputRef} titleId={titleId} />
      </Popover.Content>
    </Popover.Root>
  );
}
