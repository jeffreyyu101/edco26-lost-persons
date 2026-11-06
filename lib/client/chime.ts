// Alert signals (spec §7 Alerts → Signals). The toast always carries the alert; these are extras.
//   * A short WebAudio chime, available once a user gesture has unlocked audio (iOS requires it; the mute
//     switch silences it, which is fine).
//   * navigator.vibrate where it exists (Android; iPhone has none).
type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;

function audioCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Create / resume the AudioContext inside a user gesture. */
function unlock(): void {
  try {
    const Ctor = audioCtor();
    if (!Ctor) return;
    ctx ??= new Ctor();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  } catch {
    ctx = null;
  }
}

/** Unlocks audio on the first tap / key press. Returns the cleanup function. */
export function installAudioUnlock(): () => void {
  if (typeof window === 'undefined') return () => {};
  const events = ['pointerdown', 'keydown', 'touchend'] as const;
  const handler = () => {
    unlock();
    if (ctx && ctx.state === 'running') events.forEach((e) => window.removeEventListener(e, handler, true));
  };
  events.forEach((e) => window.addEventListener(e, handler, { capture: true, passive: true }));
  return () => events.forEach((e) => window.removeEventListener(e, handler, true));
}

/** Two soft notes (~0.45 s). Silent until audio was unlocked by a gesture. */
export function playChime(): void {
  if (!ctx || ctx.state !== 'running') return;
  try {
    const t0 = ctx.currentTime + 0.01;
    const notes: Array<[number, number]> = [
      [880, 0],
      [1318.5, 0.16],
    ];
    for (const [freq, at] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.3);
    }
  } catch {
    // Audio is a bonus; the toast is the alert.
  }
}

export function vibrate(pattern: number | number[] = [90, 60, 90]): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
  } catch {
    // Not supported.
  }
}
