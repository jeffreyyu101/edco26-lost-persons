'use client';
// The frame every request-form screen sits in (the form itself, and its loading / not-found frame).
//   page:          the phone's full-screen view, Cancel · title top bar (unchanged markup).
//   sheet / modal: a Radix dialog over the page that is open (desktop-new-tablet.html frame 1): title, the
//                  header extras (the Reporting-from chip), and ×. Focus is trapped and starts in the first
//                  field; Esc, a click outside and × all call onDismiss (blocked while a send is in flight);
//                  ⌘↵ / Ctrl+↵ anywhere in the dialog calls onSubmitShortcut. When it unmounts, focus goes
//                  back to whatever had it before (the New request button, the row, the profile's Edit).
import { Button, Dialog, Heading, IconButton } from '@radix-ui/themes';
import { X } from 'lucide-react';
import { useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { isOverlay, isSendShortcut, type FormPresentation } from './presentation';
import './request-form.css';
import { EventStageChip } from '@/components/ui/EventStageChip';

export interface FormSurfaceProps {
  presentation: FormPresentation;
  title: string;
  /** data-mode on the root ('create' | 'edit' | 'outbox'), for styling and tests. */
  mode?: string;
  /** page: the top bar's Cancel. */
  onCancel: () => void;
  cancelDisabled?: boolean;
  /** sheet / modal: ×, Esc and a click outside. */
  onDismiss: () => void;
  /** A send is in flight: Esc, outside clicks and × do nothing. */
  dismissDisabled?: boolean;
  /** sheet / modal: shown in the header between the title and × (the Reporting-from chip). */
  headerExtra?: ReactNode;
  /** sheet / modal: ⌘↵ / Ctrl+↵. */
  onSubmitShortcut?: () => void;
  /** modal: two columns (760 px) or one (520 px). */
  columns?: 1 | 2;
  /** page: the full-screen root (the form's useKeyboardFit follows the visual viewport with it). */
  rootRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

export function FormSurface({ rootRef, ...props }: FormSurfaceProps) {
  const { presentation, title, mode, children } = props;
  const contentRef = useRef<HTMLDivElement>(null);

  if (!isOverlay(presentation)) {
    return (
      <div className="lp-rf" data-mode={mode} data-testid="request-form" ref={rootRef}>
        <header className="lp-rf-nav">
          <Button type="button" variant="ghost" color="gray" size="2" className="lp-hit" onClick={props.onCancel} disabled={props.cancelDisabled}>
            Cancel
          </Button>
          <Heading as="h1" size="3" weight="medium" className="lp-rf-title">
            {title}
          </Heading>
          {/* (Events) Practice: the chip, so nobody logs a real request into practice. */}
          <span className="lp-rf-stage">
            <EventStageChip practiceOnly />
          </span>
        </header>
        {children}
      </div>
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Only keys pressed in the dialog itself: a picker portalled out of it (React still bubbles its
    // events here) handles its own Enter.
    const keys = { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing };
    if (!props.onSubmitShortcut || !isSendShortcut(keys)) return;
    if (!e.currentTarget.contains(e.target as Node)) return;
    e.preventDefault();
    props.onSubmitShortcut();
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !props.dismissDisabled) props.onDismiss();
      }}
    >
      <Dialog.Content
        ref={contentRef}
        className="lp-rf lp-rf-dlg"
        data-present={presentation}
        data-cols={props.columns ?? 2}
        data-mode={mode}
        data-testid="request-form"
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          // Start where the typing starts: the field the server pointed at, else the first field.
          e.preventDefault();
          const root = contentRef.current;
          const target = root?.querySelector<HTMLElement>('.lp-rf-in[aria-invalid="true"]') ?? root?.querySelector<HTMLElement>('.lp-rf-in') ?? root;
          target?.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(e) => {
          if (props.dismissDisabled) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (props.dismissDisabled) e.preventDefault();
        }}
        onKeyDown={onKeyDown}
      >
        <header className="lp-rf-dh">
          <Dialog.Title as="h2" size="3" mb="0" trim="normal" className="lp-rf-dtitle">
            {title}
          </Dialog.Title>
          <EventStageChip practiceOnly className="lp-rf-dstage" />
          <span className="lp-rf-sp" />
          {props.headerExtra}
          <IconButton
            type="button"
            variant="ghost"
            color="gray"
            size="2"
            className="lp-hit lp-rf-x"
            aria-label="Close"
            onClick={props.onDismiss}
            disabled={props.dismissDisabled}
          >
            <X size={17} strokeWidth={1.75} aria-hidden />
          </IconButton>
        </header>
        {children}
      </Dialog.Content>
    </Dialog.Root>
  );
}
