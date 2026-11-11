// The few telemetry constants the gate needs (lib/client/telemetry-gate.ts, in the F4 chunk), kept apart from
// lib/telemetry.ts so the F4 chunk (copied into several async chunk groups) does not carry the event tables.
// lib/telemetry.ts re-exports them.

/** localStorage keys. */
export const TEL_KEYS = {
  /** 16 random base36 characters per install. */
  device: 'lp-tel-device',
  /** Epoch ms of the next probe after the server said off. */
  off: 'lp-tel-off',
  /** '1': collect under navigator.webdriver (e2e specs opt in). */
  test: 'lp-tel-test',
  /** Epoch ms of the last "Update ready" (app_start.upd). */
  updated: 'lp-tel-upd',
  /** '1' once /health was opened on this device: the desk sidebar shows its link. */
  health: 'lp-health',
} as const;
