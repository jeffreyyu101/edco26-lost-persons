// Which device this is, and what it takes for lock-screen alerts (Web Push) to work on it (F4, spec §18
// A58; design/screens/alerts-banner.html). Pure: the banner and the Alerts sheet pass in what the browser
// says, so every case is a unit test.
//
// The step chips are each device's CURRENT UI, from the vendors' own help pages (read 2026-11-06; HANDOFF.md
// says which were also seen on a screen):
//   * iPhone Safari, iOS 27: Page Menu → Share → Add to Home Screen → Open as Web App ("Turn a website into an
//     app in Safari on iPhone", iOS 27). iOS 26: the More button (⋯) → Share → … (same article, iOS 26).
//     iOS 17 / 18: Share → Add to Home Screen ("Bookmark a website", iOS 17 and 18). Those are the default
//     Compact tab layout's taps; with the Bottom or Top layout Share is on the toolbar.
//   * iPad Safari: iPadOS 27 Share → View More → Add to Home Screen → Open as Web App; iPadOS 26 Share → More
//     (⋯) → …; 17 / 18 Share → Add to Home Screen ("Turn a website into an app in Safari on iPad").
//   * Safari on iOS 26+ freezes the OS in its user agent ("iPhone OS 18_6"): its "Version/26.x" token is the
//     real major (WebKit, "WebKit Features in Safari 26.0").
//   * A Home Screen app whose alerts were refused, iOS 17 through 27: Settings → Notifications → the app →
//     Allow Notifications ("Change notification settings on iPhone").
//   * Android Chrome: ⋮ More → Site controls → Permissions → Notifications → Allow (Google, "Use
//     notifications to get alerts", Android). An installed app: Settings → Notifications → App notifications
//     → the app (Google, "Control notifications on Android").
//   * Desktop Chrome: View site information (left of the address) → Notifications on (Google, desktop).
//     Edge: View site information → Permissions for this site → Notifications → Allow. Safari on a Mac:
//     Safari → Settings → Websites → Notifications → Allow; a web app in the Dock: System Settings →
//     Notifications → the app → Allow Notifications (Apple). Firefox: the permissions icon in the address bar
//     (the site permissions panel) → Send Notifications → × (clear the block, so the page can ask again from
//     Turn on; Mozilla, "Web Push notifications in Firefox").
import { APP_NAME } from '../activity';

export type Os = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'chromeos' | 'other';
export type Browser = 'safari' | 'chrome' | 'edge' | 'firefox' | 'samsung' | 'opera' | 'other';

export interface Platform {
  os: Os;
  browser: Browser;
  /** iOS / iPadOS major version (27, 26, 18, 17, 16.4 as 16.4), or null when unknown / not iOS. */
  iosVersion: number | null;
  /** iPad (including iPadOS Safari, which reports itself as a Mac with a touch screen). */
  ipad: boolean;
  /** Running as an installed / Home Screen app (display-mode standalone, or navigator.standalone). */
  standalone: boolean;
}

export interface DeviceSignals {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean;
}

function version(major: string | undefined, minor: string | undefined): number | null {
  const a = Number(major);
  if (!Number.isInteger(a) || a <= 0) return null;
  const b = Number(minor ?? 0);
  return Number.isInteger(b) && b > 0 && b < 10 ? a + b / 10 : a;
}

/** The device and browser from the user agent (and display mode). */
export function detectPlatform(device: DeviceSignals): Platform {
  const ua = device.userAgent || '';
  const iPadDesktop = device.platform === 'MacIntel' && device.maxTouchPoints > 1;
  const appleTouch = /\b(iPhone|iPad|iPod)\b/.test(ua) || iPadDesktop;
  let os: Os = 'other';
  if (appleTouch) os = 'ios';
  else if (/Android/i.test(ua)) os = 'android';
  else if (/CrOS/.test(ua)) os = 'chromeos';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macos';
  else if (/Windows/.test(ua)) os = 'windows';
  else if (/Linux|X11/.test(ua)) os = 'linux';

  let browser: Browser = 'other';
  if (/EdgiOS|EdgA|Edg\//.test(ua)) browser = 'edge';
  else if (/FxiOS|Firefox\//.test(ua)) browser = 'firefox';
  else if (/SamsungBrowser/.test(ua)) browser = 'samsung';
  else if (/OPR\/|OPiOS|OPT\//.test(ua)) browser = 'opera';
  else if (/CriOS|Chrome\/|Chromium\//.test(ua)) browser = 'chrome';
  else if (/Safari\//.test(ua) || (appleTouch && /AppleWebKit/.test(ua))) browser = 'safari';

  let iosVersion: number | null = null;
  if (appleTouch) {
    const fromOs = /OS (\d+)[_.](\d+)/.exec(ua);
    const osVersion = fromOs ? version(fromOs[1], fromOs[2]) : null;
    const fromSafari = browser === 'safari' ? /Version\/(\d+)(?:\.(\d+))?/.exec(ua) : null;
    const safariVersion = fromSafari ? version(fromSafari[1], fromSafari[2]) : null;
    // iOS 26+ Safari freezes the OS at 18.x; its Version/ token is then the real major.
    if (safariVersion !== null && safariVersion >= 26) iosVersion = Math.floor(safariVersion);
    else if (osVersion !== null) iosVersion = osVersion >= 17 ? Math.floor(osVersion) : osVersion;
    else iosVersion = safariVersion;
  }
  return { os, browser, iosVersion, ipad: /\biPad\b/.test(ua) || iPadDesktop, standalone: device.standalone };
}

/** One tap in a path: a glyph (mapped to a lucide icon by the banner) and its label. */
export type StepIcon = 'more-h' | 'more-v' | 'page-menu' | 'share' | 'square-plus' | 'settings' | 'sliders' | 'lock' | 'bell' | 'bell-off' | 'x';

export interface Step {
  icon?: StepIcon;
  label: string;
}

/** The taps that put the app on the Home Screen (an iPhone or iPad browser tab). */
export function installSteps(p: Platform): Step[] {
  const v = p.iosVersion ?? 0;
  const share: Step = { icon: 'share', label: 'Share' };
  const add: Step = { icon: 'square-plus', label: 'Add to Home Screen' };
  const webApp: Step = { label: 'Open as Web App' };
  if (p.browser !== 'safari') return [share, add];
  if (p.ipad) {
    if (v >= 27) return [share, { label: 'View More' }, add, webApp];
    if (v >= 26) return [share, { icon: 'more-h', label: 'More' }, add, webApp];
    return [share, add];
  }
  if (v >= 27) return [{ icon: 'page-menu', label: 'Menu' }, share, add, webApp];
  if (v >= 26) return [{ icon: 'more-h', label: 'More' }, share, add, webApp];
  return [share, add];
}

/** Where this device turns blocked notifications back on. */
export function blockedSteps(p: Platform): Step[] {
  if (p.os === 'ios') {
    return [{ icon: 'settings', label: 'Settings' }, { label: 'Notifications' }, { label: APP_NAME }, { label: 'Allow Notifications' }];
  }
  if (p.os === 'android') {
    if (p.standalone) return [{ icon: 'settings', label: 'Settings' }, { label: 'Notifications' }, { label: 'App notifications' }, { label: APP_NAME }];
    if (p.browser === 'chrome') return [{ icon: 'more-v', label: 'More' }, { label: 'Site controls' }, { label: 'Permissions' }, { label: 'Notifications' }, { label: 'Allow' }];
    return [{ icon: 'lock', label: 'Icon left of the address' }, { label: 'Permissions' }, { label: 'Notifications' }, { label: 'Allow' }];
  }
  if (p.browser === 'safari' && p.os === 'macos') {
    if (p.standalone) return [{ icon: 'settings', label: 'System Settings' }, { label: 'Notifications' }, { label: APP_NAME }, { label: 'Allow Notifications' }];
    return [{ label: 'Safari' }, { label: 'Settings' }, { label: 'Websites' }, { label: 'Notifications' }, { label: 'Allow' }];
  }
  if (p.browser === 'edge') return [{ icon: 'lock', label: 'View site information' }, { label: 'Permissions for this site' }, { label: 'Notifications' }, { label: 'Allow' }];
  // Firefox clears a block (×) rather than switching it to Allow; the page then asks again from Turn on.
  if (p.browser === 'firefox') return [{ icon: 'bell-off', label: 'Permissions icon' }, { label: 'Send Notifications' }, { icon: 'x', label: 'Clear' }];
  if (p.browser === 'chrome') return [{ icon: 'sliders', label: 'Icon left of the address' }, { label: 'Notifications' }, { label: 'On' }];
  return [{ icon: 'lock', label: 'Icon left of the address' }, { label: 'Notifications' }, { label: 'Allow' }];
}

/** The steps as one sentence for screen readers: "Tap More, then Site controls, then …". */
export function stepsSentence(lead: string, steps: readonly Step[]): string {
  return `${lead} ${steps.map((s) => s.label).join(', then ')}.`;
}

// ---------------------------------------------------------------------------------------------------
// The state machine (banner + Alerts sheet)
// ---------------------------------------------------------------------------------------------------

export type Permission = 'default' | 'granted' | 'denied';

export interface AlertsInputs {
  platform: Platform;
  /** The server has VAPID keys (POST /api/push/prefs said enabled). null: not known yet. */
  pushConfigured: boolean | null;
  /** 'serviceWorker' in navigator, 'PushManager' in window, 'Notification' in window. */
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  /** The active service worker shows pushes (lp-caps answered push: true). null: not known yet. */
  workerReady: boolean | null;
  permission: Permission;
  /** This device has a push subscription the server confirmed for the signed-in staff member. */
  subscribed: boolean;
}

/**
 *   checking     not known yet (the server or the worker has not answered): nothing shown
 *   on           alerts work here (subscribed, permission granted): no banner
 *   off          push is possible and one tap turns it on: "Alerts are off · Turn on"
 *   install      an iPhone / iPad browser tab: the Home Screen app gets push, the tab never does
 *   blocked      permission refused: the path to allow it again
 *   unsupported  no Web Push here (iOS before 16.4, a browser without it, or push off on the server)
 */
export type AlertsStatus = 'checking' | 'on' | 'off' | 'install' | 'blocked' | 'unsupported';

/** Web Push for Home Screen apps arrived in iOS / iPadOS 16.4. */
export const IOS_PUSH_MIN = 16.4;

export function alertsStatus(i: AlertsInputs): AlertsStatus {
  if (i.pushConfigured === false) return 'unsupported';
  const p = i.platform;
  if (p.os === 'ios') {
    if (p.iosVersion !== null && p.iosVersion < IOS_PUSH_MIN) return 'unsupported';
    if (!p.standalone) return i.pushConfigured === null ? 'checking' : 'install';
  }
  if (!i.hasServiceWorker || !i.hasPushManager || !i.hasNotification) return 'unsupported';
  if (i.pushConfigured === null) return 'checking';
  if (i.permission === 'denied') return 'blocked';
  if (i.workerReady === null) return 'checking';
  if (!i.workerReady) return 'unsupported';
  if (i.permission === 'granted' && i.subscribed) return 'on';
  return 'off';
}

/** The banner shows until alerts work here; never where they can't. */
export function bannerVisible(status: AlertsStatus): boolean {
  return status === 'off' || status === 'install' || status === 'blocked';
}

/** A re-check button on the blocked banner where the setting changes without leaving the page (desktop). */
export function showsRecheck(p: Platform): boolean {
  return p.os !== 'ios' && p.os !== 'android';
}

/** The device in the Alerts sheet: "On for this phone" / "… this iPad" / "… this computer". */
export function deviceNoun(p: Platform): string {
  if (p.os === 'ios') return p.ipad ? 'iPad' : 'phone';
  if (p.os === 'android') return 'phone';
  return 'computer';
}
