'use client';
// The Alerts sheet (design/screens/f34-states.html AlertsSheet, f34-v2-7): this device's state (On for this
// phone / Off / Blocked / Not supported), "Send a test alert" (a real push to this device only), and the two
// switches, "New requests" and "Updates on my requests", synced server-side for every device of the staff
// member. "New requests" is also the in-app new-request alert (the old "Alerts" bell). Opened from the avatar
// menu, the desk sidebar and rail, and once by the banner when Turn on worked.
import { Button, Switch } from '@radix-ui/themes';
import { BellOff } from 'lucide-react';
import { BellIcon, CheckIcon } from '@/components/activity/icons';
import { useEffect, useId, useState } from 'react';
import { NotifySheetRow } from '@/components/ui/NotifyStatus';
import { Sheet, SheetTitle } from '@/components/ui/Sheet';
import { blockedSteps, deviceNoun, installSteps, showsRecheck, type AlertsStatus } from '@/lib/client/alerts-platform';
import { setAlertsSheetOpen, useAlertsSheetOpen } from '@/lib/client/alerts-ui';
import { pushClient, useAlerts, type AlertPrefs } from '@/lib/client/push-client';
import { useActions, usePrefs } from '@/lib/client/store-contract';
import { useNotifyState } from '@/lib/client/system-notify';
import { StepChips } from './StepChips';
import s from './alerts.module.css';

/** The avatar menu's value for the Alerts row. */
export function alertsValue(status: AlertsStatus): string | null {
  switch (status) {
    case 'on':
      return 'On';
    case 'off':
    case 'install':
      return 'Off';
    case 'blocked':
      return 'Blocked';
    default:
      return null;
  }
}

function DeviceBlock() {
  const alerts = useAlerts();
  const notify = useNotifyState();
  const p = alerts.platform;
  const noun = p ? deviceNoun(p) : 'phone';
  switch (alerts.status) {
    case 'on':
      return (
        <div className={s.device} data-state="on" data-testid="alerts-device" role="status">
          <span className={s.deviceIcon} aria-hidden>
            <BellIcon size={20} strokeWidth={1.75} />
          </span>
          <div className={s.deviceBody}>
            <span className={s.deviceTitle}>On for this {noun}</span>
            <span className={s.deviceSub}>Lock screen + sound</span>
          </div>
        </div>
      );
    case 'off':
      return (
        <div className={s.device} data-state="off" data-testid="alerts-device">
          <span className={s.deviceIcon} aria-hidden>
            <BellOff size={20} strokeWidth={1.75} />
          </span>
          <div className={s.deviceBody}>
            <span className={s.deviceTitle}>Off</span>
          </div>
          <Button size="2" color="blue" className="lp-solid-accent lp-hit" loading={alerts.busy} onClick={() => void pushClient().turnOn()} data-testid="alerts-sheet-turn-on">
            Turn on
          </Button>
        </div>
      );
    case 'install':
      return (
        <div className={s.device} data-state="install" data-testid="alerts-device">
          <span className={s.deviceIcon} aria-hidden>
            <BellOff size={20} strokeWidth={1.75} />
          </span>
          <div className={s.deviceBody}>
            <span className={s.deviceTitle}>Off</span>
            {p ? <StepChips steps={installSteps(p)} lead="Add this app to your Home Screen: tap" /> : null}
          </div>
        </div>
      );
    case 'blocked':
      return (
        <div className={s.device} data-state="blocked" data-testid="alerts-device">
          <span className={s.deviceIcon} aria-hidden>
            <BellOff size={20} strokeWidth={1.75} />
          </span>
          <div className={s.deviceBody}>
            <span className={s.deviceTitle}>Blocked</span>
            {p ? <StepChips steps={blockedSteps(p)} lead="To allow alerts, open" /> : null}
          </div>
          {p && showsRecheck(p) ? (
            <Button size="2" variant="soft" color="gray" highContrast className="lp-hit" onClick={() => pushClient().recheck()}>
              Check again
            </Button>
          ) : null}
        </div>
      );
    case 'unsupported':
      return (
        <>
          <div className={s.device} data-state="unsupported" data-testid="alerts-device">
            <span className={s.deviceIcon} aria-hidden>
              <BellOff size={20} strokeWidth={1.75} />
            </span>
            <div className={s.deviceBody}>
              <span className={s.deviceTitle}>Not supported</span>
            </div>
          </div>
          {/* Without Web Push the page can still notify while it is open (v2.5 A52). */}
          {notify.supported ? (
            <div className={s.notifyRow}>
              <NotifySheetRow state={notify} />
            </div>
          ) : null}
        </>
      );
    default:
      return null;
  }
}

function SwitchRow({ label, sub, checked, onChange, testId }: { label: string; sub: string; checked: boolean; onChange: (on: boolean) => void; testId: string }) {
  const id = useId();
  return (
    <label className={s.switchRow} htmlFor={id}>
      <span className={s.switchText}>
        <span className={s.switchLabel}>{label}</span>
        <span className={s.switchSub}>{sub}</span>
      </span>
      {/* The whole row (at least 56 px tall) is the target; the switch itself gets a 44 px hit area with ::after
          (lp-hit would take ::before, which draws the switch's track). */}
      <Switch id={id} size="3" color="green" checked={checked} onCheckedChange={onChange} data-testid={testId} className={s.switchHit} />
    </label>
  );
}

function TestButton() {
  const alerts = useAlerts();
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(false), 4_000);
    return () => clearTimeout(t);
  }, [sent]);
  if (alerts.status !== 'on') return null;
  return (
    <Button
      size="3"
      variant="outline"
      color="gray"
      highContrast
      className={s.testButton}
      loading={alerts.busy}
      onClick={() => void pushClient().sendTest().then((ok) => setSent(ok))}
      data-testid="alerts-test"
    >
      {sent ? <CheckIcon size={17} strokeWidth={2} /> : <BellIcon size={17} strokeWidth={1.75} />}
      {sent ? 'Test alert sent' : alerts.error === 'failed' ? 'Not sent · Try again' : 'Send a test alert'}
    </Button>
  );
}

export function AlertsSheet() {
  const open = useAlertsSheetOpen();
  const alerts = useAlerts();
  const prefs = usePrefs();
  const actions = useActions();
  const switches: AlertPrefs = alerts.prefs ?? { newRequests: prefs.bell, myUpdates: true };

  const change = (key: keyof AlertPrefs, on: boolean) => {
    if (key === 'newRequests') {
      // The same switch as the in-app new-request alerts; no "Alerts are on" intro on top of this sheet.
      actions.setPref('bellIntroSeen', true);
      actions.setPref('bell', on);
    }
    void pushClient()
      .setPrefs({ [key]: on })
      .then((ok) => {
        if (!ok && key === 'newRequests' && alerts.prefs) actions.setPref('bell', !on);
      });
  };

  return (
    <Sheet open={open} onOpenChange={setAlertsSheetOpen} titleInContent>
      <div data-testid="alerts-sheet">
        <SheetTitle className={s.sheetTitle} as="h2">
          Alerts
        </SheetTitle>
        <DeviceBlock />
        <TestButton />
        <div className={s.switches}>
          <SwitchRow
            label="New requests"
            sub="Every new request logged"
            checked={switches.newRequests}
            onChange={(on) => change('newRequests', on)}
            testId="alerts-new-requests"
          />
          <SwitchRow
            label="Updates on my requests"
            sub="Answers, messages, en route"
            checked={switches.myUpdates}
            onChange={(on) => change('myUpdates', on)}
            testId="alerts-my-updates"
          />
        </div>
      </div>
    </Sheet>
  );
}
