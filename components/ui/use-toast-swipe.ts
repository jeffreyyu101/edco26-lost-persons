'use client';
// Swipe a toast at the top away (lib/client/toast-swipe.ts). While a toast shows, the gesture code is loaded and
// attached to the Toaster (.lp-toaster); with none left it lets go. Used by the shell's F4 host
// (components/activity/ActivityHost.tsx, loaded after start), so neither this nor the gesture code is on the first
// load (A25), and the Toaster carries nothing for it. Until it is there (or if it never loads), a tap and ✕ still
// close a toast.
import { useEffect } from 'react';
import { useStoreSelector, type StoreState } from '@/lib/client/store-contract';

const anyToast = (s: StoreState) => s.toasts.length > 0;

export function useToastSwipe(): void {
  const showing = useStoreSelector(anyToast);
  useEffect(() => {
    const toaster = showing ? document.querySelector<HTMLElement>('.lp-toaster') : null;
    if (!toaster) return;
    let live = true;
    let stop: (() => void) | undefined;
    import('@/lib/client/toast-swipe').then(
      ({ attachToastSwipe }) => {
        if (live) stop = attachToastSwipe(toaster);
      },
      () => undefined,
    );
    return () => {
      live = false;
      stop?.();
    };
  }, [showing]);
}
