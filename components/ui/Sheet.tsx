'use client';
// Bottom sheet (mockups: .sheet / .handle / .scrim in requests.html and states.html), on Radix Dialog so
// focus is trapped and Escape / scrim close it. STUB (Phase 1a): props are final; C (Phase 1b) ports the
// mockup styling (22 px top radius, handle, safe-area padding).
import { Dialog, VisuallyHidden } from '@radix-ui/themes';
import type { ReactNode } from 'react';

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

export function Sheet({ open, onOpenChange, title, hideTitle, description, children }: SheetProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        className="lp-sheet"
        {...(description ? {} : { 'aria-describedby': undefined })}
        style={{ position: 'fixed', left: 0, right: 0, bottom: 0, top: 'auto', maxWidth: 'none', width: '100%', borderRadius: '22px 22px 0 0' }}
      >
        {hideTitle ? (
          <VisuallyHidden>
            <Dialog.Title>{title}</Dialog.Title>
          </VisuallyHidden>
        ) : (
          <Dialog.Title size="4" weight="medium">
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
