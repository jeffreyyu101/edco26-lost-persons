'use client';
// Full-screen photo viewer (states.html "Photo"): black, "1 of 2", swipe between photos (CSS scroll snap),
// dots, the Today / Not today / Timing unknown tag, who added it and when, × to close. On Radix Dialog, so
// focus is trapped and Escape closes it. Loads full-size images, but only the current photo and its
// neighbours (low data); a photo that fails to load shows the placeholder.
import { Dialog, VisuallyHidden } from '@radix-ui/themes';
import { X } from 'lucide-react';
import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import type { PhotoInfo } from '@/lib/api-types';
import { PHOTO_TIMING_LABEL, parseStaff } from '@/lib/domain';
import { formatListTime } from '@/lib/format';
import { Bust } from './Bust';
import s from './profile.module.css';

export function photoUrl(id: string, size: 'thumb' | 'full'): string {
  return `/api/photos/${encodeURIComponent(id)}?size=${size}`;
}

const near = (i: number) => [i - 1, i, i + 1];

export interface PhotoViewerProps {
  photos: readonly PhotoInfo[];
  startIndex: number;
  /** For the screen-reader description only. */
  personLabel: string;
  timeZone: string;
  now: number;
  onClose: () => void;
}

export function PhotoViewer({ photos, startIndex, personLabel, timeZone, now, onClose }: PhotoViewerProps) {
  const count = photos.length;
  const first = Math.min(Math.max(0, startIndex), Math.max(0, count - 1));
  const [index, setIndex] = useState(first);
  const [wanted, setWanted] = useState<ReadonlySet<number>>(() => new Set(near(first)));
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const track = useRef<HTMLDivElement | null>(null);

  // The track mounts inside the dialog's portal: position it on the first photo as it attaches.
  const attachTrack = useCallback(
    (el: HTMLDivElement | null) => {
      track.current = el;
      if (el) el.scrollLeft = first * el.clientWidth;
    },
    [first],
  );

  const show = (i: number) => {
    setIndex(i);
    setWanted((w) => (near(i).every((n) => w.has(n)) ? w : new Set([...w, ...near(i)])));
  };

  const onScroll = () => {
    const el = track.current;
    if (!el || el.clientWidth === 0) return;
    const i = Math.min(count - 1, Math.max(0, Math.round(el.scrollLeft / el.clientWidth)));
    if (i !== index) show(i);
  };

  const go = (i: number) => {
    const el = track.current;
    if (!el || i < 0 || i >= count) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
    show(i);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(index - 1);
    }
  };

  const current = photos[index];
  const who = current ? parseStaff(current.uploadedBy).name : '';
  const when = current ? formatListTime(current.createdAt, now, timeZone) : '';

  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Content className={s.viewer} onKeyDown={onKeyDown} data-testid="photo-viewer">
        <div className={s.vtop}>
          <Dialog.Close>
            <button type="button" className={s.vbtn} aria-label="Close photo">
              <span>
                <X size={16} aria-hidden />
              </span>
            </button>
          </Dialog.Close>
          <Dialog.Title size="2" weight="medium" aria-live="polite">
            {count > 0 ? `${index + 1} of ${count}` : 'No photos'}
          </Dialog.Title>
          <span />
        </div>
        <VisuallyHidden>
          <Dialog.Description>Photos of {personLabel}</Dialog.Description>
        </VisuallyHidden>

        <div ref={attachTrack} className={s.track} onScroll={onScroll}>
          {photos.map((p, i) => (
            <div key={p.id} className={s.slide} aria-hidden={i !== index}>
              {wanted.has(i) && !failed.has(p.id) ? (
                <img
                  src={photoUrl(p.id, 'full')}
                  alt={`Photo ${i + 1} of ${count}, ${PHOTO_TIMING_LABEL[p.timing] ?? 'timing unknown'}`}
                  decoding="async"
                  draggable={false}
                  onError={() => setFailed((f) => new Set([...f, p.id]))}
                />
              ) : (
                <Bust size={300} className={s.bust} />
              )}
            </div>
          ))}
        </div>

        {count > 1 ? (
          <div className={s.dots}>
            {photos.map((p, i) => (
              <i key={p.id} data-on={i === index} aria-hidden />
            ))}
          </div>
        ) : null}

        <div className={s.vbot}>
          {current ? (
            <>
              <span className={s.vchip} data-testid="photo-timing">
                {PHOTO_TIMING_LABEL[current.timing] ?? PHOTO_TIMING_LABEL.unsure}
              </span>
              <span className={s.vwho}>{[who, when].filter(Boolean).join(' · ')}</span>
            </>
          ) : null}
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
