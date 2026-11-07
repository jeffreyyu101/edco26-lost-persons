// lib/client/alerts-platform.ts (F4, spec §18 A58): device + version detection from the user agent and the
// display mode, the step chips for each device's CURRENT UI (from Apple's, Google's, Microsoft's and
// Mozilla's help pages), and the banner's state machine.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_NAME } from '@/lib/activity';
import {
  HOME_SCREEN_NAME,
  alertsStatus,
  bannerVisible,
  blockedSteps,
  detectPlatform,
  deviceNoun,
  installSteps,
  showsRecheck,
  stepsSentence,
  type AlertsInputs,
  type DeviceSignals,
} from '@/lib/client/alerts-platform';

const UA = {
  iphone17: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphone18: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  // iOS 26+ Safari freezes the OS at 18_6; Version/ is the real major.
  iphone26: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1',
  iphone27: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
  iphone16_3: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1',
  // A Home Screen app: no Version/ or Safari/ token.
  iphoneApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1',
  // iPadOS Safari asks for the desktop site: a Mac with a touch screen.
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
  ipad26: 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  ipad18: 'Mozilla/5.0 (iPad; CPU OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
  androidChrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0',
  androidSamsung: 'Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

const dev = (userAgent: string, over: Partial<DeviceSignals> = {}): DeviceSignals => ({
  userAgent,
  platform: /iPhone/.test(userAgent) ? 'iPhone' : /iPad/.test(userAgent) ? 'iPad' : /Macintosh/.test(userAgent) ? 'MacIntel' : /Windows/.test(userAgent) ? 'Win32' : 'Linux armv81',
  maxTouchPoints: /iPhone|iPad|Android/.test(userAgent) ? 5 : 0,
  standalone: false,
  ...over,
});

describe('detectPlatform', () => {
  it.each([
    ['iphone17', { os: 'ios', browser: 'safari', iosVersion: 17, ipad: false }],
    ['iphone18', { os: 'ios', browser: 'safari', iosVersion: 18, ipad: false }],
    ['iphone26', { os: 'ios', browser: 'safari', iosVersion: 26, ipad: false }],
    ['iphone27', { os: 'ios', browser: 'safari', iosVersion: 27, ipad: false }],
    ['iphone16_3', { os: 'ios', browser: 'safari', iosVersion: 16.3, ipad: false }],
    ['iphoneApp', { os: 'ios', browser: 'safari', iosVersion: 18, ipad: false }],
    ['iphoneChrome', { os: 'ios', browser: 'chrome', iosVersion: 18, ipad: false }],
    ['ipad26', { os: 'ios', browser: 'safari', iosVersion: 26, ipad: true }],
    ['ipad18', { os: 'ios', browser: 'safari', iosVersion: 18, ipad: true }],
    ['androidChrome', { os: 'android', browser: 'chrome', iosVersion: null }],
    ['androidFirefox', { os: 'android', browser: 'firefox', iosVersion: null }],
    ['androidSamsung', { os: 'android', browser: 'samsung', iosVersion: null }],
    ['macChrome', { os: 'macos', browser: 'chrome', iosVersion: null }],
    ['winEdge', { os: 'windows', browser: 'edge', iosVersion: null }],
    ['winFirefox', { os: 'windows', browser: 'firefox', iosVersion: null }],
    ['macSafari', { os: 'macos', browser: 'safari', iosVersion: null }],
    ['chromebook', { os: 'chromeos', browser: 'chrome', iosVersion: null }],
  ] as const)('%s', (name, expected) => {
    expect(detectPlatform(dev(UA[name]))).toMatchObject(expected);
  });

  it('iPadOS Safari asking for the desktop site is an iPad (a Mac with a touch screen)', () => {
    expect(detectPlatform(dev(UA.ipadDesktop, { platform: 'MacIntel', maxTouchPoints: 5 }))).toMatchObject({ os: 'ios', ipad: true, iosVersion: 27 });
    expect(detectPlatform(dev(UA.ipadDesktop, { platform: 'MacIntel', maxTouchPoints: 0 }))).toMatchObject({ os: 'macos', browser: 'safari' });
  });

  it('carries the display mode', () => {
    expect(detectPlatform(dev(UA.iphoneApp, { standalone: true })).standalone).toBe(true);
  });
});

const labels = (steps: { label: string }[]) => steps.map((s) => s.label);

describe('installSteps (an iPhone or iPad Safari tab)', () => {
  // iOS / iPadOS 26+: Open as Web App is already on; the last tap is Add. A chip for the switch would make
  // people turn it off and add a Safari bookmark, which never gets push.
  it('regression: iOS 27: Page Menu → Share → Add to Home Screen → Add (Open as Web App is not a tap)', () => {
    const steps = installSteps(detectPlatform(dev(UA.iphone27)));
    expect(labels(steps)).toEqual(['Menu', 'Share', 'Add to Home Screen', 'Add']);
    expect(steps[0]?.icon).toBe('page-menu');
    expect(stepsSentence('Add this app to your Home Screen: tap', steps)).toBe(
      'Add this app to your Home Screen: tap Menu, then Share, then Add to Home Screen, then keep Open as Web App on, then Add.',
    );
  });
  it('iOS 26: Share sits behind ⋯ (More)', () => {
    const steps = installSteps(detectPlatform(dev(UA.iphone26)));
    expect(labels(steps)).toEqual(['More', 'Share', 'Add to Home Screen', 'Add']);
    expect(steps[0]?.icon).toBe('more-h');
    expect(stepsSentence('tap', steps)).toContain('keep Open as Web App on, then Add.');
  });
  it('iOS 17 and 18: Share → Add to Home Screen → Add (no web app switch there)', () => {
    expect(labels(installSteps(detectPlatform(dev(UA.iphone18))))).toEqual(['Share', 'Add to Home Screen', 'Add']);
    expect(labels(installSteps(detectPlatform(dev(UA.iphone17))))).toEqual(['Share', 'Add to Home Screen', 'Add']);
    expect(stepsSentence('tap', installSteps(detectPlatform(dev(UA.iphone18))))).toBe('tap Share, then Add to Home Screen, then Add.');
  });
  it('iPad: 27 View More, 26 More, 18 Share → Add to Home Screen → Add', () => {
    expect(labels(installSteps(detectPlatform(dev(UA.ipadDesktop, { platform: 'MacIntel', maxTouchPoints: 5 }))))).toEqual([
      'Share',
      'View More',
      'Add to Home Screen',
      'Add',
    ]);
    expect(labels(installSteps(detectPlatform(dev(UA.ipad26))))).toEqual(['Share', 'More', 'Add to Home Screen', 'Add']);
    expect(labels(installSteps(detectPlatform(dev(UA.ipad18))))).toEqual(['Share', 'Add to Home Screen', 'Add']);
  });
  it('no step is ever "Open as Web App"', () => {
    for (const ua of [UA.iphone27, UA.iphone26, UA.iphone18, UA.ipad26, UA.iphoneChrome]) {
      expect(labels(installSteps(detectPlatform(dev(ua))))).not.toContain('Open as Web App');
    }
  });
  it('another iPhone browser: Share → Add to Home Screen → Add', () => {
    expect(labels(installSteps(detectPlatform(dev(UA.iphoneChrome))))).toEqual(['Share', 'Add to Home Screen', 'Add']);
  });
});

describe('blockedSteps (the exact path to allow alerts again)', () => {
  it('regression: iPhone / iPad Home Screen app: Settings → Notifications → the app by its Home Screen name → Allow Notifications', () => {
    expect(labels(blockedSteps(detectPlatform(dev(UA.iphoneApp, { standalone: true }))))).toEqual([
      'Settings',
      'Notifications',
      'In medical?',
      'Allow Notifications',
    ]);
  });
  it('the Home Screen name is the manifest short_name and the iPhone web app title', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../public/manifest.webmanifest', import.meta.url), 'utf8')) as { name: string; short_name: string };
    const layout = readFileSync(new URL('../../../app/layout.tsx', import.meta.url), 'utf8');
    expect(manifest.short_name).toBe(HOME_SCREEN_NAME);
    expect(layout).toContain(`appleWebApp: { capable: true, title: '${HOME_SCREEN_NAME}'`);
    expect(manifest.name).toBe(APP_NAME);
  });
  it('Android Chrome: ⋮ More → Site controls → Permissions → Notifications → Allow', () => {
    expect(labels(blockedSteps(detectPlatform(dev(UA.androidChrome))))).toEqual(['More', 'Site controls', 'Permissions', 'Notifications', 'Allow']);
  });
  it('Android installed app: Settings → Notifications → App notifications → the app', () => {
    expect(labels(blockedSteps(detectPlatform(dev(UA.androidChrome, { standalone: true }))))).toEqual([
      'Settings',
      'Notifications',
      'App notifications',
      'In medical?',
    ]);
  });
  it('desktop Chrome: the icon left of the address → Notifications → On', () => {
    expect(labels(blockedSteps(detectPlatform(dev(UA.macChrome))))).toEqual(['Icon left of the address', 'Notifications', 'On']);
  });
  it('Edge: View site information → Permissions for this site → Notifications → Allow', () => {
    expect(labels(blockedSteps(detectPlatform(dev(UA.winEdge))))).toEqual(['View site information', 'Permissions for this site', 'Notifications', 'Allow']);
  });
  it('Firefox: the permissions icon → Send Notifications → Clear (the page asks again from Turn on)', () => {
    expect(labels(blockedSteps(detectPlatform(dev(UA.winFirefox))))).toEqual(['Permissions icon', 'Send Notifications', 'Clear']);
    expect(blockedSteps(detectPlatform(dev(UA.winFirefox))).map((st) => st.icon ?? null)).toEqual(['bell-off', null, 'x']);
  });
  it('Safari on a Mac: Safari → Settings → Websites → Notifications → Allow; a Dock web app: System Settings', () => {
    expect(labels(blockedSteps(detectPlatform(dev(UA.macSafari))))).toEqual(['Safari', 'Settings', 'Websites', 'Notifications', 'Allow']);
    expect(labels(blockedSteps(detectPlatform(dev(UA.macSafari, { standalone: true }))))[0]).toBe('System Settings');
  });
  it('as one sentence for screen readers', () => {
    expect(stepsSentence('To allow alerts, open', blockedSteps(detectPlatform(dev(UA.macChrome))))).toBe(
      'To allow alerts, open Icon left of the address, then Notifications, then On.',
    );
  });
  it('a re-check button only where the setting changes without leaving the page', () => {
    expect(showsRecheck(detectPlatform(dev(UA.macChrome)))).toBe(true);
    expect(showsRecheck(detectPlatform(dev(UA.androidChrome)))).toBe(false);
    expect(showsRecheck(detectPlatform(dev(UA.iphoneApp, { standalone: true })))).toBe(false);
  });
  it('names the device', () => {
    expect(deviceNoun(detectPlatform(dev(UA.iphone18)))).toBe('phone');
    expect(deviceNoun(detectPlatform(dev(UA.ipad18)))).toBe('iPad');
    expect(deviceNoun(detectPlatform(dev(UA.androidChrome)))).toBe('phone');
    expect(deviceNoun(detectPlatform(dev(UA.macChrome)))).toBe('computer');
  });
});

describe('alertsStatus (the banner state machine)', () => {
  const base = (ua: string, over: Partial<AlertsInputs> = {}, device: Partial<DeviceSignals> = {}): AlertsInputs => ({
    platform: detectPlatform(dev(ua, device)),
    pushConfigured: true,
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    workerReady: true,
    permission: 'default',
    subscribed: false,
    ...over,
  });

  it('push possible, not asked: off (banner "Alerts are off · Turn on")', () => {
    expect(alertsStatus(base(UA.macChrome))).toBe('off');
    expect(alertsStatus(base(UA.androidChrome))).toBe('off');
    expect(alertsStatus(base(UA.iphoneApp, {}, { standalone: true }))).toBe('off');
  });
  it('granted but not subscribed yet is still off (one tap subscribes)', () => {
    expect(alertsStatus(base(UA.macChrome, { permission: 'granted' }))).toBe('off');
  });
  it('subscribed with permission: on (no banner)', () => {
    expect(alertsStatus(base(UA.macChrome, { permission: 'granted', subscribed: true }))).toBe('on');
  });
  it('an iPhone or iPad Safari tab: install', () => {
    expect(alertsStatus(base(UA.iphone27, { hasPushManager: false, hasNotification: false }))).toBe('install');
    expect(alertsStatus(base(UA.ipad18, { hasPushManager: false, hasNotification: false }))).toBe('install');
  });
  it('denied: blocked', () => {
    expect(alertsStatus(base(UA.macChrome, { permission: 'denied' }))).toBe('blocked');
    expect(alertsStatus(base(UA.iphoneApp, { permission: 'denied' }, { standalone: true }))).toBe('blocked');
  });
  it('unsupported: nothing (no push on the server, iOS before 16.4, no PushManager, an older worker)', () => {
    expect(alertsStatus(base(UA.macChrome, { pushConfigured: false }))).toBe('unsupported');
    expect(alertsStatus(base(UA.iphone16_3, { hasPushManager: false }))).toBe('unsupported');
    expect(alertsStatus(base(UA.macChrome, { hasPushManager: false }))).toBe('unsupported');
    expect(alertsStatus(base(UA.macChrome, { workerReady: false }))).toBe('unsupported');
  });
  it('not known yet: checking (no banner flash)', () => {
    expect(alertsStatus(base(UA.macChrome, { pushConfigured: null }))).toBe('checking');
    expect(alertsStatus(base(UA.macChrome, { workerReady: null }))).toBe('checking');
    expect(alertsStatus(base(UA.iphone27, { pushConfigured: null }))).toBe('checking');
  });
  it('the banner shows for off, install and blocked only', () => {
    expect(['checking', 'on', 'off', 'install', 'blocked', 'unsupported'].filter((s) => bannerVisible(s as never))).toEqual(['off', 'install', 'blocked']);
  });
});
