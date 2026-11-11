'use client';
// (Events) The event's logo beside the permanent Ground Control logo (sign-in through a join link, the desk sidebar
// lockup, the brand card). A single-colour logo on a transparent background is drawn like EDC Orlando's always was:
// white on the dark brand surfaces (with the rainbow hover where the lockup has it), and in the theme's ink on the
// sign-in page. Any other logo (a photo, a coloured badge, an opaque square) is shown exactly as uploaded.
//
// Which one it is comes from the logo's own pixels, read once per URL when it has loaded (same origin: GET
// /api/events/logo/<slug> serves the bytes) and remembered on this device, so a reload does not flash. Until it is
// known the image is not shown (it is loading anyway). Decoration: the lockup names itself (alt="").
import { useCallback, useState, type CSSProperties, type SyntheticEvent } from 'react';

export type LogoKind = 'mono' | 'full';

const KIND_KEY = 'lp-logo-kind';
const memory = new Map<string, LogoKind>();

/**
 * (Phase 3) Only a versioned URL (?v=<object id>: the app's own logo URLs) is remembered. The join-link sign-in asks
 * for /api/events/logo/<slug> before it knows the version, and a replaced logo answers there too: its kind is read
 * from the pixels each time.
 */
const versioned = (src: string) => /[?&]v=/.test(src);

function remembered(src: string): LogoKind | null {
  if (!versioned(src)) return null;
  const hit = memory.get(src);
  if (hit) return hit;
  try {
    const all = JSON.parse(window.localStorage.getItem(KIND_KEY) ?? '{}') as Record<string, unknown>;
    const v = all[src];
    if (v === 'mono' || v === 'full') {
      memory.set(src, v);
      return v;
    }
  } catch {
    // unreadable: read the pixels again
  }
  return null;
}

function remember(src: string, kind: LogoKind): void {
  if (!versioned(src)) return;
  memory.set(src, kind);
  try {
    const all = JSON.parse(window.localStorage.getItem(KIND_KEY) ?? '{}') as Record<string, unknown>;
    // Only the latest few logos are worth keeping.
    const kept = Object.fromEntries(Object.entries(all).slice(-7));
    window.localStorage.setItem(KIND_KEY, JSON.stringify({ ...kept, [src]: kind }));
  } catch {
    // private mode: the pixels are read again next time
  }
}

/**
 * 'mono' when at least 5% of the logo is transparent and every visible pixel is (nearly) one colour; otherwise
 * 'full'. Pure on the RGBA bytes (exported for the unit test).
 */
export function classifyLogo(rgba: Uint8ClampedArray): LogoKind {
  let clear = 0;
  let solid = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] ?? 0;
    if (a < 16) clear += 1;
    else if (a > 200) {
      solid += 1;
      sr += rgba[i] ?? 0;
      sg += rgba[i + 1] ?? 0;
      sb += rgba[i + 2] ?? 0;
    }
  }
  const total = rgba.length / 4;
  if (total === 0 || solid === 0 || clear / total < 0.05) return 'full';
  const mr = sr / solid;
  const mg = sg / solid;
  const mb = sb / solid;
  let off = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) <= 200) continue;
    const d = Math.abs((rgba[i] ?? 0) - mr) + Math.abs((rgba[i + 1] ?? 0) - mg) + Math.abs((rgba[i + 2] ?? 0) - mb);
    if (d > 90) off += 1;
  }
  // Anti-aliased edges and a little texture are fine; a second colour is not.
  return off / solid < 0.04 ? 'mono' : 'full';
}

function measure(img: HTMLImageElement): LogoKind {
  try {
    const size = 48;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 'full';
    ctx.drawImage(img, 0, 0, size, size);
    return classifyLogo(ctx.getImageData(0, 0, size, size).data);
  } catch {
    return 'full';
  }
}

export interface EventLogoProps {
  src: string;
  /** 'dark': always on a dark surface (brand card, desk lockup); 'theme': on the page canvas (sign-in, Ended). */
  surface: 'dark' | 'theme';
  className?: string;
  /** The rainbow layer's class (the desk lockup's hover); masked by the logo itself, mono logos only. */
  rainbowClassName?: string;
  /** Rendered height in px (the width follows the logo's own shape). */
  height: number;
  loading?: 'lazy';
}

/** The event logo (decoration: alt=""), tinted only when it is a single-colour transparent logo. */
export function EventLogo({ src, surface, className, rainbowClassName, height, loading }: EventLogoProps) {
  const [kind, setKind] = useState<LogoKind | null>(() => (typeof window === 'undefined' ? null : remembered(src)));
  const [failed, setFailed] = useState(false);
  const onLoad = useCallback(
    (e: SyntheticEvent<HTMLImageElement>) => {
      const known = remembered(src);
      const k = known ?? measure(e.currentTarget);
      if (!known) remember(src, k);
      setKind(k);
    },
    [src],
  );
  if (failed) return null;
  const mono = kind === 'mono';
  const style: CSSProperties = { height, width: 'auto', visibility: kind ? 'visible' : 'hidden' };
  return (
    <span data-logo-kind={kind ?? 'unknown'} data-testid="event-logo" style={{ position: 'relative', display: 'inline-block', lineHeight: 0, flex: 'none' }}>
      <img
        className={[className, mono ? (surface === 'dark' ? 'lp-logo-white' : 'lp-logo-ink') : ''].filter(Boolean).join(' ')}
        src={src}
        alt=""
        height={height}
        style={style}
        decoding="async"
        draggable={false}
        loading={loading}
        onLoad={onLoad}
        onError={() => setFailed(true)}
      />
      {mono && rainbowClassName ? (
        <span
          className={rainbowClassName}
          aria-hidden
          data-testid="event-logo-rainbow"
          style={{ WebkitMaskImage: `url("${src}")`, maskImage: `url("${src}")` }}
        />
      ) : null}
    </span>
  );
}
