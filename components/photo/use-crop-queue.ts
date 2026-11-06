'use client';
// The quick-crop step between the file picker and preparePhoto (design/DECISIONS.md v2.2 #10). Picked files
// wait here and are shown one at a time in the CropSheet; "Use photo" keeps the file with its crop (null =
// the whole photo), "Retake" drops it and opens the picker again (in the same tap, which iOS needs). When
// the last waiting file is handled, every kept one is handed to `onDone` in order, so the caller prepares
// and adds them the way it always has.
//
// Retake on the last waiting photo while others of the run were kept leaves the run open: the photo picked
// instead joins it (it is shown as the next of the same run), and the kept ones are handed over together
// with it, so nothing is prepared, added or shown before the retake is answered and no photo of the run is
// lost (F2 review: a profile's Add with two photos, Use on the first, Retake on the second lost the first).
// If the picker is closed without a photo (its `cancel` event, or, where a browser has none, the page
// back in front with no photo a moment later), the kept ones are handed over then.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { CropRect } from '@/lib/client/crop';

export interface CropPick {
  file: File;
  crop: CropRect | null;
}

export interface CropItem {
  id: number;
  file: File;
}

interface QueueState {
  items: readonly CropItem[];
  /** Files in this run (picked, including ones already handled), for "2 of 3". */
  total: number;
}

const EMPTY: QueueState = { items: [], total: 0 };

/**
 * After a Retake, once the page is back in front (the picker or the camera closed), how long to wait for the
 * picked photo before deciding none is coming (browsers without the file input's `cancel` event).
 */
export const RETAKE_SETTLE_MS = 1_500;

export interface CropQueue {
  /** The photo on screen, or null when the step is closed. */
  current: CropItem | null;
  /** "index of total" while a run has more than one photo. */
  position: { index: number; total: number } | null;
  /** Files waiting or kept but not yet handed over (count them against the photo limit). */
  pending: () => number;
  /** True while a Retake's picker is open and kept photos wait for it (the caller keeps its input enabled). */
  retaking: boolean;
  enqueue: (files: readonly File[]) => void;
  use: (crop: CropRect | null) => void;
  retake: () => void;
}

export function useCropQueue(onDone: (picks: CropPick[]) => void, picker: RefObject<HTMLInputElement | null>): CropQueue {
  const [state, setState] = useState<QueueState>(EMPTY);
  const [retaking, setRetaking] = useState(false);
  const live = useRef<QueueState>(EMPTY);
  const kept = useRef<CropPick[]>([]);
  const seq = useRef(0);
  const callbacks = useRef({ onDone });
  useEffect(() => {
    callbacks.current = { onDone };
  }, [onDone]);
  // Stops watching the Retake's picker (listeners and timer), when one is open.
  const unwatch = useRef<(() => void) | null>(null);

  const stopRetake = useCallback(() => {
    unwatch.current?.();
    unwatch.current = null;
    setRetaking(false);
  }, []);

  const commit = useCallback((next: QueueState) => {
    live.current = next;
    setState(next);
    if (next.items.length > 0) return;
    const picks = kept.current;
    kept.current = [];
    if (picks.length > 0) callbacks.current.onDone(picks);
  }, []);

  // The Retake's picker closed with no photo: hand over what the run kept.
  const settle = useCallback(() => {
    if (!unwatch.current) return;
    stopRetake();
    if (live.current.items.length === 0) commit(EMPTY);
  }, [commit, stopRetake]);

  useEffect(() => () => unwatch.current?.(), []);

  const enqueue = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      const items = files.map((file) => ({ id: (seq.current += 1), file }));
      const cur = live.current;
      // The photo picked after a Retake joins the open run ("2 of 2" after one kept); otherwise a run with
      // nothing waiting starts over.
      const joining = unwatch.current !== null;
      if (joining) stopRetake();
      const base = cur.items.length > 0 || joining ? cur.total : 0;
      live.current = { items: [...cur.items, ...items], total: base + items.length };
      setState(live.current);
    },
    [stopRetake],
  );

  const use = useCallback(
    (crop: CropRect | null) => {
      const [head, ...rest] = live.current.items;
      if (!head) return;
      kept.current.push({ file: head.file, crop });
      commit({ items: rest, total: rest.length === 0 ? 0 : live.current.total });
    },
    [commit],
  );

  const watchPicker = useCallback(() => {
    unwatch.current?.();
    const input = picker.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const back = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(settle, RETAKE_SETTLE_MS);
    };
    input?.addEventListener('cancel', settle);
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    unwatch.current = () => {
      input?.removeEventListener('cancel', settle);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
      if (timer !== undefined) clearTimeout(timer);
    };
    setRetaking(true);
  }, [picker, settle]);

  const retake = useCallback(() => {
    const [head, ...rest] = live.current.items;
    if (!head) return;
    const next = { items: rest, total: live.current.total - 1 };
    if (rest.length === 0 && kept.current.length > 0) {
      // The last waiting photo of a run that kept others: the run stays open for the photo picked instead.
      live.current = next;
      setState(next);
      watchPicker();
    } else {
      commit(rest.length === 0 ? EMPTY : next);
    }
    picker.current?.click();
  }, [commit, picker, watchPicker]);

  const pending = useCallback(() => live.current.items.length + kept.current.length, []);

  const current = state.items[0] ?? null;
  const position = current && state.total > 1 ? { index: state.total - state.items.length + 1, total: state.total } : null;
  return { current, position, pending, retaking, enqueue, use, retake };
}
