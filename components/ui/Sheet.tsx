'use client';
// Bottom sheet (requests.html / states.html .sheet, .handle, .scrim) on Radix Dialog, so focus is trapped
// and Escape / the scrim close it. 22 px top radius, the drag handle, safe-area padding, and it rides
// above the iOS keyboard (visualViewport) so a field inside it (the post picker's "Where?") stays visible.
// Scrolls when its content is taller than the screen.
import { Dialog, VisuallyHidden } from '@radix-ui/themes';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import styles from './ui.module.css';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Always required for screen readers; shown as the sheet heading unless hideTitle. */
  title: string;
  hideTitle?: boolean;
  /** Optional screen-reader description. */
  description?: string;
  children: ReactNode;
}

/** Height of the on-screen keyboard (0 when closed or unknown). */
function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!active || typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      setInset(0);
    };
  }, [active]);
  return inset;
}

export function Sheet({ open, onOpenChange, title, hideTitle, description, children }: SheetProps) {
  const keyboard = useKeyboardInset(open);
  const style = { '--lp-kb': `${keyboard}px` } as CSSProperties;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className={`lp-sheet ${styles.sheet}`} style={style} {...(description ? {} : { 'aria-describedby': undefined })}>
        <div className={styles.handle} aria-hidden />
        {hideTitle ? (
          <VisuallyHidden>
            <Dialog.Title>{title}</Dialog.Title>
          </VisuallyHidden>
        ) : (
          <Dialog.Title size="4" weight="medium" mb="3" trim="normal">
            {title}
          </Dialog.Title>
        )}
        {description ? (
          <VisuallyHidden>
            <Dialog.Description>{description}</Dialog.Description>
          </VisuallyHidden>
        ) : null}
        {children}
      </Dialog.Content>
    </Dialog.Root>
  );
}
