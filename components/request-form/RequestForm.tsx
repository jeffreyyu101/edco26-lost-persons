'use client';
// The request form body (new-request.html): "Reporting from" row, the ID card (photo slot, Name, Age,
// Gender), Wearing, Last seen (+ stage chips while focused), Friend or family, More details, and the sticky
// Send button. Controlled: RequestFormView owns the values, the draft and the store calls.
// STUB (Phase 1a): props are final; F (Phase 2) builds the real form.
import { Button, Text } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import type { DraftPhoto } from '@/lib/client/store-contract';
import type { RequestFormValues } from '@/lib/client/form-values';
import type { EditSection, PhotoTiming } from '@/lib/domain';

export type RequestFormMode = 'create' | 'edit' | 'outbox';

export interface RequestFormProps {
  mode: RequestFormMode;
  /** Which groups to show: 'all' for create / outbox; edit may show only 'person' or 'friend' (A24). */
  section: EditSection;
  values: RequestFormValues;
  onChange: (values: RequestFormValues) => void;
  /**
   * create: the photos chosen in this form (editable). outbox: the job's photos, shown READ-ONLY (no add,
   * remove or timing toggle; onPhotosChange / onPhotoTimingChange are never called) because
   * store.outbox.update() replaces only the payload; to change photos, discard the job and log it again.
   * The view maps OutboxPhoto → DraftPhoto (width/height 0). edit: unused, photos are added from the profile.
   */
  photos: readonly DraftPhoto[];
  onPhotosChange: (photos: DraftPhoto[]) => void;
  photoTiming: PhotoTiming;
  onPhotoTimingChange: (timing: PhotoTiming) => void;
  /** Turns the button into "Save offline" and shows the offline banner (create only). */
  offline: boolean;
  /** A send / save is in flight. */
  busy: boolean;
  /** Banner above the form, e.g. the 409 review: "Someone else just updated this…". */
  notice?: ReactNode;
  /** "Similar open request: LP-1009" (informational; links to the profile). */
  duplicateOf?: { id: string; caseNumber: number } | null;
  /** "Send request", "Save offline", "Save", "Resend". */
  submitLabel: string;
  submitDisabled: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}

export function RequestForm(props: RequestFormProps) {
  const { values, onChange } = props;
  const field = (key: keyof RequestFormValues, label: string) => (
    <label style={{ display: 'grid', gap: 4 }}>
      <Text size="2" color="gray">
        {label}
      </Text>
      <input
        value={values[key]}
        onChange={(e) => onChange({ ...values, [key]: e.currentTarget.value })}
        style={{ fontSize: 16, minHeight: 44 }}
      />
    </label>
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
      style={{ display: 'grid', gap: 12, padding: 16 }}
    >
      {props.notice}
      {props.section !== 'friend' ? (
        <>
          {field('name', 'Name')}
          {field('age', 'Age')}
          {field('clothing', 'Wearing')}
          {field('lastSeen', 'Last seen')}
        </>
      ) : null}
      {props.section !== 'person' ? (
        <>
          {field('contactName', 'Name')}
          {field('contactPhone', 'Phone')}
          {field('contactRelationship', 'Relation')}
        </>
      ) : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button type="button" variant="soft" color="gray" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" highContrast disabled={props.submitDisabled || props.busy} style={{ flex: 1 }}>
          {props.submitLabel}
        </Button>
      </div>
    </form>
  );
}
