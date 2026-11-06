'use client';
// Bottom sheet (requests.html / states.html .sheet, .handle, .scrim) on Radix Dialog, so focus is trapped
// and Escape / the scrim close it. 22 px top radius, the drag handle, safe-area padding, and it rides
// above the iOS keyboard (visualViewport) so a field inside it (the post picker's "Where?") stays visible.
// Scrolls when its content is taller than the screen.
import { Dialog, VisuallyHidden } from '@radix-ui/themes';
import { useEffect, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import styles from './ui.module.css';

interface SheetBase {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  /** A tap on the scrim closes the sheet (default). False: only Escape and the sheet's own buttons do. */
  dismissOnOutside?: boolean;
  /** Focused when the sheet opens, instead of its first control. */
  initialFocus?: RefObject<HTMLElement | null>;
}

export type SheetProps = SheetBase &
  (
    | {
        /** Always required for screen readers; shown as the sheet heading unless hideTitle. */
        title: string;
        hideTitle?: boolean;
        /** Optional screen-reader description. */
        description?: string;
        titleInContent?: never;
      }
    | {
        /**
         * The children render the visible heading as <SheetTitle> (and any visible description line as
         * <SheetDescription>), which name and describe the dialog. Nothing is repeated in hidden text.
         */
        titleInContent: true;
        title?: never;
        hideTitle?: never;
        description?: never;
      }
  );

/** The sheet's visible heading, when the content lays it out itself (Sheet titleInContent). */
export const SheetTitle = Dialog.Title;
/** A visible line that describes the sheet (Sheet titleInContent). */
export const SheetDescription = Dialog.Description;

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

export function Sheet(props: SheetProps) {
  const { open, onOpenChange, title, hideTitle, description, titleInContent, children, dismissOnOutside = true, initialFocus } = props;
  const keyboard = useKeyboardInset(open);
  const style = { '--lp-kb': `${keyboard}px` } as CSSProperties;
  // Radix points aria-describedby at a Description it finds; without one, say so (no console warning).
  const describedBy = description || titleInContent ? {} : { 'aria-describedby': undefined };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        className={`lp-sheet ${styles.sheet}`}
        style={style}
        {...describedBy}
        onPointerDownOutside={dismissOnOutside ? undefined : (e) => e.preventDefault()}
        onOpenAutoFocus={
          initialFocus
            ? (e) => {
                if (!initialFocus.current) return;
                e.preventDefault();
                initialFocus.current.focus();
              }
            : undefined
        }
      >
        <div className={styles.handle} aria-hidden />
        {titleInContent ? null : hideTitle ? (
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
