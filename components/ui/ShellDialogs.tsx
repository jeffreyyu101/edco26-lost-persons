'use client';
// Dialogs hosted by the `/` shell (spec §7 Outbox / Alerts). Loaded on demand by app/app-shell.tsx, so
// they cost nothing on the first load.
//   * OutboxPromptDialog: "Send 2 requests saved by Dana Kim?" when the signed-in staff differs from the
//     saver (the server attributes requests to whoever is signed in when they send, A13).
//   * ActivityHost (F4): Web Push, Activity and the Alerts sheet, which replaced the "Alerts are on" sheet
//     (BellIntroSheet) that the old Alerts toggle opened. Loaded through this chunk's import site, so the first
//     load's chunk map gains no entry (A25).
import { AlertDialog, Button } from '@radix-ui/themes';
import type { OutboxPrompt } from '@/lib/client/store-contract';
import styles from './ui.module.css';

export { ActivityHostSlot as ActivityHost } from '@/components/activity/slots';

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
        {/* Send is the safe choice (nothing is lost), so it is AlertDialog.Cancel and takes the initial focus. */}
        <div className={styles.dialogButtons}>
          <AlertDialog.Action>
            <Button size="3" variant="soft" color="red" onClick={() => onAnswer(false)}>
              Discard
            </Button>
          </AlertDialog.Action>
          <AlertDialog.Cancel>
            <Button size="3" highContrast onClick={() => onAnswer(true)}>
              Send
            </Button>
          </AlertDialog.Cancel>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
