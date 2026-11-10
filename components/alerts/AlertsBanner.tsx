'use client';
// The alerts reminder (design/screens/alerts-banner.html, alerts-banner-1..5): on All, Pending and My
// requests until lock-screen alerts work on this device, then gone. Not dismissible.
//   off       "Alerts are off" · Turn on (asks from that tap and subscribes; the Alerts sheet opens once on)
//   install   iPhone / iPad Safari tab: "Get alerts on your lock screen" + the taps to the Home Screen app
//   blocked   "Alerts are blocked" + this device's path to allow them (+ re-check on a computer)
//   anything else: nothing
// (Phase 3) Until the answer is in, the box this device showed last (banner-place.tsx), so a cold load doesn't move
// the list; each banner drawn is remembered for the next load, and "no banner" forgets it.
import { Button, IconButton } from '@radix-ui/themes';
import { BellOff } from 'lucide-react';
import { BellIcon, RefreshIcon } from '@/components/activity/icons';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { bannerVisible, blockedSteps, installSteps, showsRecheck } from '@/lib/client/alerts-platform';
import { openAlertsSheet } from '@/lib/client/alerts-ui';
import { pushClient, useAlerts } from '@/lib/client/push-client';
import { useSession } from '@/lib/client/store-contract';
import { StepChips } from './StepChips';
import { BannerPlace, forgetBanner, rememberBanner, type BannerPlaceName } from './banner-place';
import s from './alerts.module.css';

/** Starts the push client for whoever is signed in (idempotent; the Activity host does the same). */
export function usePushStarted(): void {
  const session = useSession();
  const staff = session.status === 'active' ? session.staff : null;
  useEffect(() => {
    if (staff) pushClient().start(staff);
  }, [staff]);
}

export function AlertsBanner({ place = 'list' }: { place?: BannerPlaceName }) {
  usePushStarted();
  const alerts = useAlerts();
  const turningOn = useRef(false);
  const ref = useRef<HTMLElement | null>(null);
  const known = alerts.status !== 'checking' && !!alerts.platform;
  const shown = known && bannerVisible(alerts.status);

  // What the next cold load draws first (banner-place.tsx): this banner's state and box, or none.
  useLayoutEffect(() => {
    if (!known) return;
    const el = ref.current;
    if (!shown || !el) {
      forgetBanner();
      return;
    }
    const state = alerts.status as 'off' | 'install' | 'blocked';
    rememberBanner(state, place, el);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => rememberBanner(state, place, el));
    observer.observe(el);
    return () => observer.disconnect();
  }, [known, shown, alerts.status, place]);

  // The banner's Turn on worked: the Alerts sheet opens once, with the switches.
  useEffect(() => {
    if (turningOn.current && alerts.status === 'on') {
      turningOn.current = false;
      openAlertsSheet();
    }
  }, [alerts.status]);

  if (!known) return <BannerPlace place={place} />;
  if (!shown || !alerts.platform) return null;
  const p = alerts.platform;

  if (alerts.status === 'off') {
    return (
      <section ref={ref} className={s.banner} data-state="off" aria-label="Alerts" data-testid="alerts-banner">
        <span className={s.icon} aria-hidden>
          <BellIcon size={18} strokeWidth={1.75} />
        </span>
        <span className={`${s.title} ${s.body}`}>Alerts are off</span>
        <Button
          size="2"
          color="blue"
          className={`${s.turnOn} lp-solid-accent lp-hit`}
          loading={alerts.busy}
          onClick={() => {
            turningOn.current = true;
            // Inside the tap: the browser asks for permission from it.
            void pushClient().turnOn();
          }}
          data-testid="alerts-turn-on"
        >
          Turn on
        </Button>
      </section>
    );
  }

  if (alerts.status === 'install') {
    return (
      <section ref={ref} className={s.banner} data-state="install" aria-label="Alerts" data-testid="alerts-banner">
        <span className={s.icon} aria-hidden>
          <BellIcon size={18} strokeWidth={1.75} />
        </span>
        <div className={s.body}>
          <span className={s.title}>Get alerts on your lock screen</span>
          <StepChips steps={installSteps(p)} lead="Add this app to your Home Screen: tap" testId="alerts-install-steps" />
        </div>
      </section>
    );
  }

  return (
    <section ref={ref} className={s.banner} data-state="blocked" aria-label="Alerts" data-testid="alerts-banner">
      <span className={s.icon} aria-hidden>
        <BellOff size={18} strokeWidth={1.75} />
      </span>
      <div className={s.body}>
        <span className={s.title}>Alerts are blocked</span>
        <StepChips steps={blockedSteps(p)} lead="To allow alerts, open" testId="alerts-blocked-steps" />
      </div>
      {showsRecheck(p) ? (
        <IconButton
          size="3"
          variant="soft"
          color="gray"
          highContrast
          className={`${s.recheck} lp-hit`}
          aria-label="Check again"
          onClick={() => pushClient().recheck()}
          data-testid="alerts-recheck"
        >
          <RefreshIcon size={16} strokeWidth={2} />
        </IconButton>
      ) : null}
    </section>
  );
}
