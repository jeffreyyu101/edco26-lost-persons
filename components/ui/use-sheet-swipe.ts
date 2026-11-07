'use client';
// Swipe down to close a phone bottom sheet (lib/client/sheet-swipe.ts, loaded when a sheet first opens, so the
// first load does not grow; the build is precached, so it loads offline too). `close` is the sheet's own close
// (onOpenChange(false), the Escape / scrim path), run synchronously so a sheet kept open springs back; null:
// this sheet does not swipe away. Until the code is there (or if it never loads), ✕, the scrim and Escape
// still close the sheet.
import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';

export function useSheetSwipe(node: HTMLElement | null, close: (() => void) | null): void {
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  const enabled = close !== null;
  useEffect(() => {
    if (!node || !enabled) return;
    let live = true;
    let stop: (() => void) | undefined;
    import('@/lib/client/sheet-swipe').then(
      ({ attachSheetSwipe }) => {
        if (live) stop = attachSheetSwipe(node, () => flushSync(() => latest.current?.()));
      },
      () => undefined,
    );
    return () => {
      live = false;
      stop?.();
    };
  }, [node, enabled]);
}
