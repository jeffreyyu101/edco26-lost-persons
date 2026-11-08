'use client';
// The trail drawer: a problem's example events (up to 3, ‹ ›), each as a vertical timeline of its breadcrumbs, the
// event itself last and highlighted. A native modal <dialog> styled as a sheet on the right (no Radix Themes JS here:
// it would share modules with `/`'s first load, A25).
import { useEffect, useRef, useState } from 'react';
import { Bell, ChevronLeft, ChevronRight, Circle, Cloud, Eye, Hand, Keyboard, Layers, MoveVertical, TextCursorInput, TriangleAlert, Wifi, WifiOff, X, type Icon } from './icons';
import { SignalChip } from './parts';
import { crumbKind, fmtDt, signalLabel, type Example, type Problem } from './health-model';
import s from './health.module.css';

const CRUMB_ICON: Readonly<Record<ReturnType<typeof crumbKind>, Icon>> = {
  view: Eye,
  tap: Hand,
  swipe: MoveVertical,
  sheet: Layers,
  net: Cloud,
  online: Wifi,
  offline: WifiOff,
  toast: Bell,
  key: Keyboard,
  field: TextCursorInput,
  error: TriangleAlert,
  other: Circle,
};

const KIND_WORDS: Readonly<Record<ReturnType<typeof crumbKind>, string>> = {
  view: 'View',
  tap: 'Tap',
  swipe: 'Swipe',
  sheet: 'Sheet',
  net: 'Request',
  online: 'Connection up',
  offline: 'Connection down',
  toast: 'Toast',
  key: 'Key',
  field: 'Field',
  error: 'Error',
  other: 'Event',
};

/** A native modal dialog that follows `open` (Escape and the backdrop close it through onClose). */
export function useModal(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', '');
      }
    } else if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCloseEvent = () => onClose();
    d.addEventListener('close', onCloseEvent);
    return () => d.removeEventListener('close', onCloseEvent);
  }, [onClose]);
  return ref;
}

export function TrailDrawer({ problem, examples, onClose }: { problem: Problem | null; examples: Example[]; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const close = () => {
    setIndex(0);
    onClose();
  };
  const ref = useModal(!!problem, close);
  const list = problem ? problem.examples.map((id) => examples.find((e) => e.id === id)).filter((e): e is Example => !!e) : [];
  const ex = list[Math.min(index, Math.max(0, list.length - 1))];
  return (
    <dialog
      ref={ref}
      className={s.drawer}
      aria-labelledby="health-trail-title"
      data-testid="health-trail"
      onClick={(e) => {
        // A click on the backdrop (the dialog box itself, outside its content) closes it.
        if (e.target === e.currentTarget) ref.current?.close();
      }}
    >
      {problem ? (
        <div className={s.drawerBody}>
          <div className={s.panelHead}>
            <h2 id="health-trail-title" className={s.h2} style={{ marginRight: 'auto' }}>
              Trail
            </h2>
            {list.length > 1 ? (
              <>
                <button type="button" className={s.iconBtn} data-ghost="" aria-label="Previous example" disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))}>
                  <ChevronLeft size={16} />
                </button>
                <span className={s.sub} role="img" aria-label={`Example ${index + 1} of ${list.length}`}>
                  {index + 1}/{list.length}
                </span>
                <button type="button" className={s.iconBtn} data-ghost="" aria-label="Next example" disabled={index >= list.length - 1} onClick={() => setIndex((i) => Math.min(list.length - 1, i + 1))}>
                  <ChevronRight size={16} />
                </button>
              </>
            ) : null}
            <button type="button" className={s.iconBtn} data-ghost="" aria-label="Close" onClick={() => ref.current?.close()}>
              <X size={16} />
            </button>
          </div>
          <SignalChip name={problem.name} label={signalLabel(problem.name)} />
          {!ex ? (
            <p className={s.empty}>—</p>
          ) : (
            <ol className={s.timeline}>
              {(ex.trail ?? []).map(([dt, code], i) => {
                const kind = crumbKind(code);
                const Glyph = CRUMB_ICON[kind];
                return (
                  <li key={i} className={s.crumb}>
                    <span className={s.mono}>{fmtDt(dt)}</span>
                    <Glyph size={14} />
                    <span className={s.mono}>
                      <span className={s.sr}>{KIND_WORDS[kind]}: </span>
                      {code}
                    </span>
                  </li>
                );
              })}
              <li className={s.crumb} data-event="">
                <span className={s.mono}>0.0 s</span>
                <TriangleAlert size={14} />
                <span className={s.mono}>
                  <span className={s.sr}>{signalLabel(ex.name)}: </span>
                  {ex.name} {ex.view ?? ''} {ex.area ?? ''} {ex.ctl ?? ''}
                </span>
              </li>
            </ol>
          )}
        </div>
      ) : null}
    </dialog>
  );
}
