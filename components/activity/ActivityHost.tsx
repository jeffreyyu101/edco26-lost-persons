'use client';
// The `/` shell's host for Web Push and Activity (F4), loaded with next/dynamic after start so the first load
// does not grow:
//   * starts the push client for whoever is signed in (re-binds this device to them) and the Activity client;
//     forgets both when the session ends or another staff member signs in;
//   * a request opened from anywhere (Activity, a list, a deep link, a push click) marks its Activity row read;
//   * a push: the worker asks ({type: 'lp-push'} with a port) whether this page is in front by the page's own
//     rule (system-notify inFront: visible, and on a computer focused) and shows nothing when it is; the page
//     syncs at once, and its toast carries the event (lib/client/push-toast.ts: the push's own line when the
//     sync raised no toast for it), so the bell and the toast show without waiting for the next poll;
//   * the "New requests" switch (server-side) is the phone's new-request alert pref (the old bell);
//   * draws the Alerts sheet.
import { useEffect, useRef } from 'react';
import { AlertsSheet } from '@/components/alerts/AlertsSheet';
import { usePushStarted } from '@/components/alerts/AlertsBanner';
import { activityClient } from '@/lib/client/activity-client';
import { useView } from '@/lib/client/nav';
import { useAlerts } from '@/lib/client/push-client';
import { createPushToasts, type PushMessage } from '@/lib/client/push-toast';
import { useActions, useAppStore, usePrefs, useSession } from '@/lib/client/store-contract';
import { browserWindow, inFront } from '@/lib/client/system-notify';

export const PUSH_MESSAGE = 'lp-push';

function openedRequestId(view: ReturnType<typeof useView>): string | null {
  return view.name === 'profile' || view.name === 'edit' ? view.id : null;
}

export function ActivityHost() {
  usePushStarted();
  const session = useSession();
  const actions = useActions();
  const store = useAppStore();
  const prefs = usePrefs();
  const alerts = useAlerts();
  const view = useView();
  const staff = session.status === 'active' ? session.staff : null;
  const lastStaff = useRef<string | null>(null);

  // Activity belongs to one staff member: forget it when the session ends or someone else signs in.
  useEffect(() => {
    const client = activityClient();
    if (session.status === 'signed_out' || session.status === 'expired') {
      client.reset();
      lastStaff.current = null;
      return;
    }
    if (!staff) return;
    if (lastStaff.current !== null && lastStaff.current !== staff) client.reset();
    lastStaff.current = staff;
    client.start();
  }, [session.status, staff]);

  // Read state belongs to the request: opening it marks its row read.
  const opened = openedRequestId(view);
  useEffect(() => {
    if (!opened || !staff) return;
    const client = activityClient();
    const check = () => {
      if (client.getState().unreadIds.has(opened)) client.markRead(opened);
    };
    check();
    // A deep link opens before the first sync says what is unread; an event can also arrive while it is open.
    return client.subscribe(check);
  }, [opened, staff]);

  // A push: say whether this page is in front (then the worker shows nothing and the app carries it), and sync.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const toasts = createPushToasts(store);
    const onMessage = (event: MessageEvent<PushMessage | null>) => {
      if (event.data?.type !== PUSH_MESSAGE) return;
      const front = inFront(browserWindow());
      try {
        event.ports?.[0]?.postMessage({ front });
      } catch {
        // the worker stopped waiting
      }
      toasts.handle(event.data, front);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      toasts.stop();
    };
  }, [store]);

  // The server's "New requests" switch is this phone's new-request alert (prefs.bell).
  const serverNewRequests = alerts.prefs?.newRequests;
  useEffect(() => {
    if (serverNewRequests === undefined || serverNewRequests === prefs.bell) return;
    actions.setPref('bellIntroSeen', true);
    actions.setPref('bell', serverNewRequests);
    // Only when the server's value changes: a local flip is sent to the server by the sheet itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverNewRequests]);

  return <AlertsSheet />;
}
