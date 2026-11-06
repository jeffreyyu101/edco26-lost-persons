'use client';
// The quick-crop step between the file picker and preparePhoto (design/DECISIONS.md v2.2 #10). Picked files
// wait here and are shown one at a time in the CropSheet; "Use photo" keeps the file with its crop (null =
// the whole photo), "Retake" drops it and opens the picker again (in the same tap, which iOS needs). When
// the last waiting file is handled, every kept one is handed to `onDone` in order, so the caller prepares
// and adds them the way it always has.
import { useCallback, useEffect, useRef, useState } from 'react';
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

export interface CropQueue {
  /** The photo on screen, or null when the step is closed. */
  current: CropItem | null;
  /** "index of total" while a run has more than one photo. */
  position: { index: number; total: number } | null;
  /** Files waiting or kept but not yet handed over (count them against the photo limit). */
  pending: () => number;
  enqueue: (files: readonly File[]) => void;
  use: (crop: CropRect | null) => void;
  retake: () => void;
}

export function useCropQueue(onDone: (picks: CropPick[]) => void, reopenPicker: () => void): CropQueue {
  const [state, setState] = useState<QueueState>(EMPTY);
  const live = useRef<QueueState>(EMPTY);
  const kept = useRef<CropPick[]>([]);
  const seq = useRef(0);
  const callbacks = useRef({ onDone, reopenPicker });
  useEffect(() => {
    callbacks.current = { onDone, reopenPicker };
  }, [onDone, reopenPicker]);

  const commit = useCallback((next: QueueState) => {
    live.current = next;
    setState(next);
    if (next.items.length > 0) return;
    const picks = kept.current;
    kept.current = [];
    if (picks.length > 0) callbacks.current.onDone(picks);
  }, []);

  const enqueue = useCallback((files: readonly File[]) => {
    if (files.length === 0) return;
    const items = files.map((file) => ({ id: (seq.current += 1), file }));
    const cur = live.current;
    live.current = { items: [...cur.items, ...items], total: (cur.items.length === 0 ? 0 : cur.total) + items.length };
    setState(live.current);
  }, []);

  const use = useCallback(
    (crop: CropRect | null) => {
      const [head, ...rest] = live.current.items;
      if (!head) return;
      kept.current.push({ file: head.file, crop });
      commit({ items: rest, total: rest.length === 0 ? 0 : live.current.total });
    },
    [commit],
  );

  const retake = useCallback(() => {
    const [head, ...rest] = live.current.items;
    if (!head) return;
    commit({ items: rest, total: rest.length === 0 ? 0 : live.current.total - 1 });
    callbacks.current.reopenPicker();
  }, [commit]);

  const pending = useCallback(() => live.current.items.length + kept.current.length, []);

  const current = state.items[0] ?? null;
  const position = current && state.total > 1 ? { index: state.total - state.items.length + 1, total: state.total } : null;
  return { current, position, pending, enqueue, use, retake };
}
