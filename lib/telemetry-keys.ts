// The few telemetry constants the gate needs (lib/client/telemetry-gate.ts, in the F4 chunk), kept apart from
// lib/telemetry.ts so the F4 chunk (copied into several async chunk groups) does not carry the event tables.
// lib/telemetry.ts re-exports them.

/**
 * Collection stops on its own at 2026-11-10 06:00 ET (11:00 UTC; EST since Nov 1), Monday morning, unless the server
 * says otherwise (lp_tel_settings.off_at, carried in every answer as `until`).
 */
export const TEL_DEFAULT_UNTIL = Date.UTC(2026, 10, 10, 11, 0, 0);

/** localStorage keys. */
export const TEL_KEYS = {
  /** 16 random base36 characters per install. */
  device: 'lp-tel-device',
  /** Epoch ms collection stops at (from the last answer). */
  until: 'lp-tel-until',
  /** Epoch ms of the next probe after the server said off. */
  off: 'lp-tel-off',
  /** '1': collect under navigator.webdriver (e2e specs opt in). */
  test: 'lp-tel-test',
  /** Epoch ms of the last "Update ready" (app_start.upd). */
  updated: 'lp-tel-upd',
  /** '1' once /health was opened on this device: the desk sidebar shows its link. */
  health: 'lp-health',
} as const;
