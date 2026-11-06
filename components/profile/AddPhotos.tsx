'use client';
// Adding photos to an existing request from the profile's Add tile (Jeffrey's "Photo from: Today / Not
// today" + "Add photo", kept). The tile opens the file picker; the chosen photos are compressed by the
// store (preparePhoto) and shown here with the Today / Not today choice before they upload. A failed upload
// keeps the sheet open: retrying sends the same photo ids, which the server treats idempotently.
import { Button, SegmentedControl, Text } from '@radix-ui/themes';
import { Camera } from 'lucide-react';
import { useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import type { DraftPhoto } from '@/lib/client/store-contract';
import { PHOTO_TIMING_LABEL, type PhotoTiming } from '@/lib/domain';
import s from './profile.module.css';

/** A prepared photo and its preview URL (created and revoked by the owner of the picks). */
export interface PhotoPick {
  photo: DraftPhoto;
  url: string;
}

export interface AddPhotosSheetProps {
  picks: readonly PhotoPick[];
  /** Files that couldn't be read (shown as an error when nothing could be prepared). */
  unreadable: number;
  busy: boolean;
  error: string | null;
  disabled: boolean;
  onAdd: (timing: PhotoTiming) => void;
  onClose: () => void;
}

export function AddPhotosSheet({ picks, unreadable, busy, error, disabled, onAdd, onClose }: AddPhotosSheetProps) {
  const [timing, setTiming] = useState<PhotoTiming>('today');
  const n = picks.length;
  const message = error ?? (n === 0 && unreadable > 0 ? "Couldn't read that photo" : null);

  return (
    <Sheet open onOpenChange={(open) => (open || busy ? undefined : onClose())} title={n > 1 ? `Add ${n} photos` : 'Add photo'}>
      <div className={s.picks} style={{ marginTop: 12 }}>
        {picks.map((p, i) => (
          <img key={p.photo.photoId} src={p.url} alt={`New photo ${i + 1}`} />
        ))}
      </div>
      {n > 0 ? (
        <SegmentedControl.Root
          size="2"
          value={timing}
          onValueChange={(v) => setTiming(v === 'older' ? 'older' : 'today')}
          style={{ width: '100%' }}
          aria-label="When the photo was taken"
        >
          <SegmentedControl.Item value="today">{PHOTO_TIMING_LABEL.today}</SegmentedControl.Item>
          <SegmentedControl.Item value="older">{PHOTO_TIMING_LABEL.older}</SegmentedControl.Item>
        </SegmentedControl.Root>
      ) : null}
      {message ? (
        <Text as="p" role="alert" className={s.error} mt="3">
          {message}
        </Text>
      ) : null}
      <Button
        size="3"
        highContrast
        mt="4"
        style={{ width: '100%' }}
        disabled={n === 0 || busy || disabled}
        loading={busy}
        onClick={() => onAdd(timing)}
      >
        <Camera size={16} aria-hidden />
        {disabled ? 'Needs a connection' : error ? 'Try again' : n > 1 ? `Add ${n} photos` : 'Add photo'}
      </Button>
    </Sheet>
  );
}
