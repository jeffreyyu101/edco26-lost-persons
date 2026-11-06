'use client';
// The portrait photo slot of the ID card (new-request.html .slot): empty, it opens the camera / library
// (file input, image/*, multiple, max 3). With photos, it shows the first one, a count badge and the
// Today / Not today tag (tap toggles), and tapping the photo opens a small sheet to add or remove photos.
// Read-only (needs-attention editor, A33): shows the job's photos, no add / remove / toggle.
import { Button, IconButton, SegmentedControl, Spinner } from '@radix-ui/themes';
import { Camera, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { useActions, type DraftPhoto } from '@/lib/client/store-contract';
import { MAX_PHOTOS, PHOTO_TIMING_LABEL, type PhotoTiming } from '@/lib/domain';
import { photoIntake } from './form-logic';
import './request-form.css';

/** An <img> showing a Blob through an object URL that is revoked when the blob changes or on unmount. */
export function BlobImage({ blob, alt }: { blob: Blob; alt: string }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = ref.current;
    if (!img) return;
    const url = URL.createObjectURL(blob);
    img.src = url;
    return () => {
      img.removeAttribute('src');
      URL.revokeObjectURL(url);
    };
  }, [blob]);
  return <img ref={ref} alt={alt} decoding="async" draggable={false} />;
}

export interface PhotoSlotProps {
  photos: readonly DraftPhoto[];
  onPhotosChange?: (photos: DraftPhoto[]) => void;
  timing: PhotoTiming;
  onTimingChange?: (timing: PhotoTiming) => void;
  readOnly?: boolean;
  disabled?: boolean;
}

const otherTiming = (t: PhotoTiming): PhotoTiming => (t === 'today' ? 'older' : 'today');

export function PhotoSlot({ photos, onPhotosChange, timing, onTimingChange, readOnly, disabled }: PhotoSlotProps) {
  const actions = useActions();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  // The latest photos, for the end of an async add (a remove may have happened meanwhile).
  const photosRef = useRef(photos);
  const onPhotosChangeRef = useRef(onPhotosChange);
  useEffect(() => {
    photosRef.current = photos;
    onPhotosChangeRef.current = onPhotosChange;
  }, [photos, onPhotosChange]);
  const count = photos.length;
  const first = photos[0];
  const timingLabel = PHOTO_TIMING_LABEL[timing];
  const canAdd = !readOnly && !disabled && !preparing && count < MAX_PHOTOS;

  const pick = () => {
    if (canAdd) fileRef.current?.click();
  };

  const onFiles = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (fileRef.current) fileRef.current.value = '';
    if (files.length === 0 || readOnly || !onPhotosChange) return;
    const { take, dropped } = photoIntake(count, files.length);
    if (take === 0) return;
    setPreparing(true);
    const added: DraftPhoto[] = [];
    let failed = 0;
    // One at a time: decoding several camera photos at once can exhaust memory on older iPhones.
    for (const file of files.slice(0, take)) {
      try {
        added.push(await actions.preparePhoto(file));
      } catch {
        failed += 1;
      }
    }
    setPreparing(false);
    if (added.length > 0) onPhotosChangeRef.current?.([...photosRef.current, ...added].slice(0, MAX_PHOTOS));
    if (failed > 0) {
      actions.showToast({ tone: 'red', icon: 'alert', title: failed === 1 ? "Couldn't add that photo" : `Couldn't add ${failed} photos`, durationMs: 5_000 });
    } else if (dropped > 0) {
      actions.showToast({ tone: 'neutral', icon: 'info', title: `${MAX_PHOTOS} photos max`, durationMs: 4_000 });
    }
  };

  const slotLabel = count === 0
    ? preparing
      ? 'Adding photo'
      : 'Add photo'
    : readOnly
      ? `${count} ${count === 1 ? 'photo' : 'photos'}, ${timingLabel.toLowerCase()}`
      : `${count} ${count === 1 ? 'photo' : 'photos'}, ${timingLabel.toLowerCase()}. Add or remove`;

  return (
    <div className="lp-rf-slotw">
      <button
        type="button"
        className="lp-rf-slot"
        data-has={count > 0 ? '' : undefined}
        data-readonly={readOnly ? '' : undefined}
        aria-label={slotLabel}
        aria-disabled={readOnly || disabled || undefined}
        onClick={() => {
          if (readOnly || disabled) return;
          if (count === 0) pick();
          else setManagerOpen(true);
        }}
      >
        {first ? <BlobImage blob={first.thumbBlob} alt="" /> : null}
        {preparing ? <Spinner size="2" /> : count === 0 ? <Camera size={20} strokeWidth={1.75} aria-hidden /> : null}
        {count > 0 ? (
          <span className="lp-rf-cnt" aria-hidden>
            {count}
          </span>
        ) : null}
      </button>
      {count > 0 ? (
        <button
          type="button"
          className="lp-rf-when"
          disabled={readOnly || disabled}
          aria-label={readOnly ? `Taken ${timingLabel.toLowerCase()}` : `Taken ${timingLabel.toLowerCase()}. Switch to ${PHOTO_TIMING_LABEL[otherTiming(timing)].toLowerCase()}`}
          onClick={() => onTimingChange?.(otherTiming(timing))}
        >
          <span>{timingLabel}</span>
        </button>
      ) : null}
      {!readOnly ? (
        <input
          ref={fileRef}
          className="lp-rf-file"
          type="file"
          accept="image/*"
          multiple
          tabIndex={-1}
          aria-hidden
          onChange={(e) => void onFiles(e.currentTarget.files)}
        />
      ) : null}
      {!readOnly ? (
        <PhotoManager
          open={managerOpen}
          onOpenChange={setManagerOpen}
          photos={photos}
          timing={timing}
          canAdd={canAdd}
          preparing={preparing}
          onAdd={pick}
          onRemove={(photoId) => {
            const next = photos.filter((p) => p.photoId !== photoId);
            onPhotosChange?.(next);
            if (next.length === 0) setManagerOpen(false);
          }}
          onTimingChange={(t) => onTimingChange?.(t)}
        />
      ) : null}
    </div>
  );
}

interface PhotoManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  photos: readonly DraftPhoto[];
  timing: PhotoTiming;
  canAdd: boolean;
  preparing: boolean;
  onAdd: () => void;
  onRemove: (photoId: string) => void;
  onTimingChange: (timing: PhotoTiming) => void;
}

function PhotoManager({ open, onOpenChange, photos, timing, canAdd, preparing, onAdd, onRemove, onTimingChange }: PhotoManagerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Photos">
      <div className="lp-rf-tiles">
        {photos.map((p, i) => (
          <div key={p.photoId} className="lp-rf-tile">
            <BlobImage blob={p.thumbBlob} alt={`Photo ${i + 1} of ${photos.length}`} />
            <IconButton
              className="lp-rf-tile-x"
              type="button"
              size="1"
              radius="full"
              variant="solid"
              color="gray"
              highContrast
              aria-label={`Remove photo ${i + 1}`}
              disabled={preparing}
              onClick={() => onRemove(p.photoId)}
            >
              <X size={14} strokeWidth={2} aria-hidden />
            </IconButton>
          </div>
        ))}
        {photos.length < MAX_PHOTOS ? (
          <div className="lp-rf-tile" style={{ background: 'transparent' }}>
            <button type="button" className="lp-rf-add" aria-label="Add photo" disabled={!canAdd} onClick={onAdd}>
              {preparing ? <Spinner size="2" /> : <Plus size={20} strokeWidth={1.75} aria-hidden />}
            </button>
          </div>
        ) : null}
      </div>
      <SegmentedControl.Root
        className="lp-rf-timing"
        size="2"
        value={timing}
        onValueChange={(v) => onTimingChange(v as PhotoTiming)}
        aria-label="When the photos were taken"
        style={{ width: '100%' }}
      >
        <SegmentedControl.Item value="today">{PHOTO_TIMING_LABEL.today}</SegmentedControl.Item>
        <SegmentedControl.Item value="older">{PHOTO_TIMING_LABEL.older}</SegmentedControl.Item>
      </SegmentedControl.Root>
      <Button type="button" size="3" highContrast mt="4" style={{ width: '100%' }} onClick={() => onOpenChange(false)}>
        Done
      </Button>
    </Sheet>
  );
}
