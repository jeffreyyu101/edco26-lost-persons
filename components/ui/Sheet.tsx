'use client';
// Bottom sheet (requests.html / states.html .sheet, .handle, .scrim) on Radix Dialog, so focus is trapped
// and Escape / the scrim close it. 22 px top radius, the drag handle, safe-area padding. Scrolls when its
// content is taller than the screen.
//
// With a field in it (the location's "Bed or chair", the post picker's "Where?") it sits flush on the phone's
// keyboard (hotfix F5.1): its overlay follows the visual viewport (lib/client/visual-viewport.ts
// followKeyboard; ui.module.css), so the scrim covers everything on screen and the sheet's bottom is the
// keyboard's top, and once a field has the focus on a touch screen the page behind is pinned
// (lockPageScroll) so the keyboard's scroll-into-view can't move it. Both end when the sheet is gone.
import { Dialog, VisuallyHidden } from '@radix-ui/themes';
import { useEffect, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from 'react';
import { followKeyboard, isTextField, lockPageScroll, revealDelta } from '@/lib/client/visual-viewport';
import styles from './ui.module.css';

interface SheetBase {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  /** A tap on the scrim closes the sheet (default). False: only Escape and the sheet's own buttons do. */
  dismissOnOutside?: boolean;
  /** Focused when the sheet opens, instead of its first control. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Escape pressed: call preventDefault() to keep the sheet open (Radix Dialog's onEscapeKeyDown). */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
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

/** Pins the page once a text field in the sheet has the focus on a touch screen (`unlock` holds the release). */
function pinFor(unlock: RefObject<(() => void) | null>, field: unknown) {
  if (!unlock.current && isTextField(field) && matchMedia('(pointer: coarse)').matches) unlock.current = lockPageScroll();
}

/**
 * The keyboard while the sheet is on screen (`node`: its content, from mount to unmount, the slide-out
 * included). Returns the content's focus handler, which pins the page for a text field.
 */
function useSheetKeyboard(node: HTMLElement | null): (e: FocusEvent) => void {
  const unlock = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!node) return;
    const stop = followKeyboard(node.closest<HTMLElement>('.rt-BaseDialogOverlay') ?? node);
    // A field focused as it opened (autoFocus), before this ran.
    if (node.contains(document.activeElement)) pinFor(unlock, document.activeElement);
    // A sheet taller than the space above the keyboard scrolls: its focused field stays in view, above its foot.
    const vv = window.visualViewport;
    let frame = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          const field = document.activeElement;
          if (!(field instanceof HTMLElement) || !isTextField(field) || !node.contains(field)) return;
          const view = node.getBoundingClientRect();
          const foot = parseFloat(getComputedStyle(node).paddingBottom) || 0;
          const delta = revealDelta({ top: view.top, bottom: view.bottom - foot }, field.getBoundingClientRect(), 12);
          if (delta !== 0) node.scrollBy({ top: delta });
        });
      });
    };
    vv?.addEventListener('resize', reveal);
    node.addEventListener('focusin', reveal);
    return () => {
      cancelAnimationFrame(frame);
      vv?.removeEventListener('resize', reveal);
      node.removeEventListener('focusin', reveal);
      stop();
      unlock.current?.();
      unlock.current = null;
    };
  }, [node]);
  return (e) => pinFor(unlock, e.target);
}

export function Sheet(props: SheetProps) {
  const { open, onOpenChange, title, hideTitle, description, titleInContent, children, dismissOnOutside = true, initialFocus, onEscapeKeyDown } = props;
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const onFocus = useSheetKeyboard(node);
  // Radix points aria-describedby at a Description it finds; without one, say so (no console warning).
  const describedBy = description || titleInContent ? {} : { 'aria-describedby': undefined };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        ref={setNode}
        className={`lp-sheet ${styles.sheet}`}
        onFocus={onFocus}
        {...describedBy}
        onPointerDownOutside={dismissOnOutside ? undefined : (e) => e.preventDefault()}
        onEscapeKeyDown={onEscapeKeyDown}
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
