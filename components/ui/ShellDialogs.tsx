'use client';
// Dialogs hosted by the `/` shell (spec §7 Outbox / Alerts). Loaded on demand by app/app-shell.tsx, so
// they cost nothing on the first load.
//   * OutboxPromptDialog: "Send 2 requests saved by Dana Kim?" when the signed-in staff differs from the
//     saver (the server attributes requests to whoever is signed in when they send, A13).
//   * BellIntroSheet: "Alerts are on", the first time the bell is turned on. Alerts show while the app is
//     open; the Home Screen tip notes that a Home Screen app signs in and keeps its requests separately.
//     Never promises lock-screen alerts.
import { AlertDialog, Button, Heading, Text } from '@radix-ui/themes';
import { BellRing, LogIn, Share, SquarePlus } from 'lucide-react';
import type { OutboxPrompt } from '@/lib/client/store-contract';
import { Sheet } from './Sheet';
import styles from './ui.module.css';

export interface OutboxPromptDialogProps {
  prompt: OutboxPrompt;
  onAnswer: (send: boolean) => void;
}

export function OutboxPromptDialog({ prompt, onAnswer }: OutboxPromptDialogProps) {
  const noun = prompt.count === 1 ? 'request' : 'requests';
  return (
    <AlertDialog.Root open>
      <AlertDialog.Content maxWidth="360px" size="3">
        <AlertDialog.Title size="4" weight="medium" mb="1">
          Send {prompt.count} {noun} saved by {prompt.savedBy}?
        </AlertDialog.Title>
        <AlertDialog.Description size="2" color="gray">
          {prompt.sendAs ? `As ${prompt.sendAs}` : null}
        </AlertDialog.Description>
        <div className={styles.dialogButtons}>
          <AlertDialog.Cancel>
            <Button size="3" variant="soft" color="red" onClick={() => onAnswer(false)}>
              Discard
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action>
            <Button size="3" highContrast onClick={() => onAnswer(true)}>
              Send
            </Button>
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

export interface BellIntroSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

export function BellIntroSheet({ open, onOpenChange }: BellIntroSheetProps) {
  const tip = !isStandalone();
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Alerts are on" hideTitle>
      <div className={styles.sheetHead} aria-hidden>
        <span className={styles.sheetHeadIcon}>
          <BellRing size={20} strokeWidth={1.75} />
        </span>
        <Heading as="h2" size="4" weight="medium">
          Alerts are on
        </Heading>
      </div>
      <Text as="p" size="2" color="gray" mt="3">
        They show while this app is open.
      </Text>
      {tip ? (
        <div className={styles.steps}>
          <div className={styles.step}>
            <span className={styles.stepIcon} aria-hidden>
              <Share size={18} strokeWidth={1.75} />
            </span>
            <Text size="3">
              Tap <b>Share</b>
            </Text>
          </div>
          <div className={styles.step}>
            <span className={styles.stepIcon} aria-hidden>
              <SquarePlus size={18} strokeWidth={1.75} />
            </span>
            <Text size="3">Add to Home Screen</Text>
          </div>
          <div className={styles.step}>
            <span className={styles.stepIcon} aria-hidden>
              <LogIn size={18} strokeWidth={1.75} />
            </span>
            <Text size="3">Sign in there · it keeps its own requests</Text>
          </div>
        </div>
      ) : (
        <div style={{ height: 16 }} />
      )}
      <Button size="3" highContrast className={styles.fullButton} onClick={() => onOpenChange(false)}>
        Got it
      </Button>
    </Sheet>
  );
}
