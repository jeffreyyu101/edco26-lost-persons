'use client';
// The quick-crop step (design/DECISIONS.md v2.2 #10): shown after a photo is taken or picked, before it is
// prepared. The selection starts as the whole photo, so one tap on "Use photo" keeps it unchanged.
//   pointer   drag a corner (44 px targets) to resize, drag inside to move, drag on the dimmed part (or
//             anywhere while the whole photo is selected) to draw a new rectangle; mouse and touch alike
//   keyboard  Tab to the selection or a corner, arrow keys move it (Shift: further); Enter uses the photo,
//             Escape skips the crop (the whole photo)
//   other     a tap on the scrim does nothing (no accidental add); a photo the browser can't show is passed
//             on uncropped, so preparePhoto reports it the way it always has
import { Button, IconButton, Text, VisuallyHidden } from '@radix-ui/themes';
import { Check, Maximize, RotateCcw } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { Sheet, SheetDescription, SheetTitle } from '@/components/ui/Sheet';
import {
  FULL_CROP,
  arrowDelta,
  cornerPoint,
  cropFromPoints,
  describeCrop,
  isFullCrop,
  moveCrop,
  nudgeCrop,
  resizeCorner,
  type CropCorner,
  type CropRect,
} from '@/lib/client/crop';
import type { CropItem } from './use-crop-queue';
import s from './crop.module.css';

export interface CropSheetProps {
  item: CropItem | null;
  position: { index: number; total: number } | null;
  onUse: (crop: CropRect | null) => void;
  onRetake: () => void;
}

export function CropSheet({ item, position, onUse, onRetake }: CropSheetProps) {
  // Keep the last photo on screen while the sheet slides away.
  const [last, setLast] = useState<CropItem | null>(item);
  if (item && item !== last) setLast(item);
  const shown = item ?? last;
  const useButton = useRef<HTMLButtonElement | null>(null);
  // Each photo is answered once: a double tap, or Enter then Escape, never reaches the next photo.
  const answered = useRef<number | null>(null);
  const once = (fn: () => void) => {
    if (!item || answered.current === item.id) return;
    answered.current = item.id;
    fn();
  };
  const use = (crop: CropRect | null) => once(() => onUse(crop && !isFullCrop(crop) ? crop : null));
  const retake = () => once(onRetake);
  return (
    <Sheet
      open={item !== null}
      onOpenChange={(open) => {
        // Escape: skip the crop, keep the whole photo.
        if (!open) use(null);
      }}
      titleInContent
      dismissOnOutside={false}
      initialFocus={useButton}
    >
      {shown ? <CropBody key={shown.id} file={shown.file} position={item ? position : null} useButton={useButton} onUse={use} onRetake={retake} /> : null}
    </Sheet>
  );
}

type Drag =
  | { kind: 'corner'; id: number; corner: CropCorner; start: CropRect; ox: number; oy: number }
  | { kind: 'move'; id: number; start: CropRect; px: number; py: number }
  | { kind: 'draw'; id: number; px: number; py: number; drawing: boolean };

/** Pointer travel (px) before a press on the photo starts a new rectangle (a tap changes nothing). */
const DRAW_SLOP = 6;
/** Each corner's 44 px target sits mostly inside the selection: the corner point is this far in from its edge. */
const HANDLE = 44;
const HANDLE_OUT = 10;

const CORNERS: ReadonlyArray<{ corner: CropCorner; label: string }> = [
  { corner: 'nw', label: 'Top left corner' },
  { corner: 'ne', label: 'Top right corner' },
  { corner: 'sw', label: 'Bottom left corner' },
  { corner: 'se', label: 'Bottom right corner' },
];

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

function cornerStyle(rect: CropRect, corner: CropCorner): CSSProperties {
  const p = cornerPoint(rect, corner);
  const dx = corner === 'nw' || corner === 'sw' ? -HANDLE_OUT : HANDLE_OUT - HANDLE;
  const dy = corner === 'nw' || corner === 'ne' ? -HANDLE_OUT : HANDLE_OUT - HANDLE;
  return { left: `calc(${pct(p.x)} + ${dx}px)`, top: `calc(${pct(p.y)} + ${dy}px)` };
}

interface CropBodyProps {
  file: File;
  position: { index: number; total: number } | null;
  useButton: RefObject<HTMLButtonElement | null>;
  onUse: (crop: CropRect | null) => void;
  onRetake: () => void;
}

function CropBody({ file, position, useButton, onUse, onRetake }: CropBodyProps) {
  const [rect, setRect] = useState<CropRect>(FULL_CROP);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [announce, setAnnounce] = useState('');
  const keysId = useId();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const drag = useRef<Drag | null>(null);

  // The next photo of a multi-photo pick replaces this body: keep keyboard focus on Use photo.
  useEffect(() => {
    const button = useButton.current;
    if (button && !button.contains(document.activeElement)) button.focus({ preventScroll: true });
  }, [useButton]);

  // The photo through an object URL, revoked when it changes or the step closes.
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const url = URL.createObjectURL(file);
    img.src = url;
    return () => {
      img.removeAttribute('src');
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // Fit the photo into the stage: its width, and at most 58 % of the screen's height (520 px on a laptop).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !natural) return;
    const fit = () => {
      const cs = getComputedStyle(stage);
      const width = stage.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      if (width <= 0) return;
      const maxHeight = Math.min(window.innerHeight * 0.58, 520);
      const scale = Math.min(width / natural.width, maxHeight / natural.height);
      setBox({ width: Math.max(1, Math.floor(natural.width * scale)), height: Math.max(1, Math.floor(natural.height * scale)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [natural]);

  const point = (e: PointerEvent) => {
    const b = frameRef.current?.getBoundingClientRect();
    if (!b || b.width === 0 || b.height === 0) return null;
    return { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height, w: b.width, h: b.height };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = point(e);
    if (!p) return;
    const corner = (e.target as HTMLElement).closest<HTMLElement>('[data-corner]')?.dataset.corner as CropCorner | undefined;
    const inside = p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
    if (corner) {
      const c = cornerPoint(rect, corner);
      drag.current = { kind: 'corner', id: e.pointerId, corner, start: rect, ox: c.x - p.x, oy: c.y - p.y };
    } else if (inside && !isFullCrop(rect)) {
      drag.current = { kind: 'move', id: e.pointerId, start: rect, px: p.x, py: p.y };
    } else {
      drag.current = { kind: 'draw', id: e.pointerId, px: p.x, py: p.y, drawing: false };
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const p = point(e);
    if (!p) return;
    if (d.kind === 'corner') {
      setRect(resizeCorner(d.start, d.corner, p.x + d.ox, p.y + d.oy));
    } else if (d.kind === 'move') {
      setRect(moveCrop(d.start, p.x - d.px, p.y - d.py));
    } else {
      if (!d.drawing && Math.hypot((p.x - d.px) * p.w, (p.y - d.py) * p.h) < DRAW_SLOP) return;
      d.drawing = true;
      setRect(cropFromPoints(d.px, d.py, p.x, p.y));
    }
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onUse(rect);
      return;
    }
    const delta = arrowDelta(e.key, e.shiftKey);
    if (!delta) return;
    const target = e.target as HTMLElement;
    const corner = target.dataset.corner as CropCorner | undefined;
    if (!corner && target.dataset.selection === undefined) return;
    e.preventDefault();
    const next = nudgeCrop(rect, corner ?? 'move', delta.dx, delta.dy);
    setRect(next);
    setAnnounce(describeCrop(next));
  };

  const cropped = !isFullCrop(rect);
  const rectStyle: CSSProperties = { left: pct(rect.x), top: pct(rect.y), width: pct(rect.width), height: pct(rect.height) };

  return (
    <div className={s.body}>
      <div className={s.head}>
        <SheetTitle size="4" weight="medium" mb="0" trim="normal">
          Crop photo
        </SheetTitle>
        <VisuallyHidden>
          <SheetDescription>
            The whole photo is selected. Drag a corner, or draw a rectangle, to cut away the phone and what is around it.
          </SheetDescription>
        </VisuallyHidden>
        <div className={s.headEnd}>
          {position ? (
            <Text size="2" color="gray" className={s.count}>
              {position.index} of {position.total}
            </Text>
          ) : null}
          {cropped ? (
            <IconButton
              type="button"
              size="2"
              variant="ghost"
              color="gray"
              className="lp-hit"
              aria-label="Reset to the whole photo"
              onClick={() => {
                setRect(FULL_CROP);
                setAnnounce(describeCrop(FULL_CROP));
              }}
            >
              <Maximize size={16} aria-hidden />
            </IconButton>
          ) : null}
        </div>
      </div>

      <div ref={stageRef} className={s.stage} data-ready={box ? '' : undefined}>
        <div
          ref={frameRef}
          className={s.frame}
          data-ready={box ? '' : undefined}
          style={box ? { width: box.width, height: box.height } : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
          data-testid="crop-frame"
        >
          <img
            ref={imgRef}
            alt=""
            draggable={false}
            decoding="async"
            onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth || 1, height: e.currentTarget.naturalHeight || 1 })}
            onError={() => onUse(null)}
          />
          {box ? (
            <>
              <div className={s.shade} aria-hidden>
                <div className={s.hole} style={rectStyle} />
              </div>
              <div
                className={s.sel}
                data-selection=""
                data-full={cropped ? undefined : ''}
                role="button"
                tabIndex={0}
                aria-label={cropped ? describeCrop(rect) : 'Crop area, whole photo'}
                aria-roledescription="crop selection"
                aria-describedby={keysId}
                style={rectStyle}
              />
              {CORNERS.map(({ corner, label }) => (
                <div
                  key={corner}
                  className={s.corner}
                  data-corner={corner}
                  role="button"
                  tabIndex={0}
                  aria-label={label}
                  aria-roledescription="crop handle"
                  aria-describedby={keysId}
                  style={cornerStyle(rect, corner)}
                />
              ))}
            </>
          ) : null}
        </div>
      </div>
      <VisuallyHidden>
        <span id={keysId}>Arrow keys move it, Shift with an arrow moves it further. Enter uses the photo, Escape keeps the whole photo.</span>
        <span aria-live="polite">{announce}</span>
      </VisuallyHidden>

      <div className={s.actions}>
        <Button type="button" size="3" variant="soft" color="gray" className="lp-hit" onClick={onRetake}>
          <RotateCcw size={16} aria-hidden />
          Retake
        </Button>
        <Button ref={useButton} type="button" size="3" highContrast className="lp-hit" onClick={() => onUse(rect)}>
          <Check size={16} aria-hidden />
          Use photo
        </Button>
      </div>
    </div>
  );
}
