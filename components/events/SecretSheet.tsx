'use client';
// (Events, lead screens) A sheet that sets a secret: an event's staff password (Event setup) or the Ground Control
// lead passcode (Events). One field with a show / hide button and Save. Never shows a stored secret: there is none
// to show (only hashes are kept). The value is never logged or kept after the sheet closes.
import { Button, IconButton, TextField } from '@radix-ui/themes';
import { Eye, EyeOff } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { FieldError } from './parts';
import s from './events.module.css';

interface SecretSheetProps {
  title: string;
  label: string;
  /** Saves; resolves with an error message for the field, or null when saved (the sheet then closes). */
  onSave: (value: string) => Promise<string | null>;
  onClose: () => void;
  testId?: string;
}

export function SecretSheet({ title, label, onSave, onClose, testId }: SecretSheetProps) {
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const id = useId();
  const errId = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (value.length < 8) {
      setError('At least 8 characters');
      ref.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const problem = await onSave(value);
    setBusy(false);
    if (problem) {
      setError(problem);
      ref.current?.focus();
    }
  };
  return (
    <Sheet open onOpenChange={(open) => (open || busy ? undefined : onClose())} title={title} initialFocus={ref} dismissOnOutside={!busy}>
      <form onSubmit={submit} noValidate data-testid={testId}>
        <div className={s.sheetField}>
          <label className={s.fieldLabel} htmlFor={id}>
            {label}
          </label>
          <TextField.Root
            id={id}
            ref={ref}
            size="3"
            type={show ? 'text' : 'password'}
            value={value}
            maxLength={200}
            autoComplete="new-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
            data-testid="secret-input"
          >
            <TextField.Slot side="right">
              <IconButton
                type="button"
                size="2"
                variant="ghost"
                color="gray"
                className={s.hit}
                aria-label={show ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
                aria-pressed={show}
                onClick={() => setShow((v) => !v)}
              >
                {show ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
              </IconButton>
            </TextField.Slot>
          </TextField.Root>
          {error ? <FieldError id={errId}>{error}</FieldError> : null}
        </div>
        <div className={s.sheetActs}>
          <Button type="button" size="3" variant="soft" color="gray" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="3" highContrast loading={busy} data-testid="secret-save">
            Save
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
