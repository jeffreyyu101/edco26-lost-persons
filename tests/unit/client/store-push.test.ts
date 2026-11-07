// No double alerts with Web Push (F4, spec §18 A54), through the real store: on a device with a push
// subscription the page never shows its own system notification for an alert (the push does); in front the
// toast is unchanged; without a subscription the page's notification is as before (v2.5 A52). The Activity
// unread count rides on sync (sync-extras). Fake notifier; synthetic rows only.
import { afterEach, describe, expect, it } from 'vitest';
import type { AlertNotifier, AlertRoute, SystemNotice } from '@/lib/client/system-notify';
import { systemNotice } from '@/lib/client/system-notify';
import { setPushSubscribed } from '@/lib/client/push-coverage';
import { lastActivityUnread, resetSyncExtras } from '@/lib/client/sync-extras';
import { STATUS } from '@/lib/domain';
import { advance } from './helpers/env';
import { boot, installStoreHooks, ready } from './helpers/boot';
import { FakeServer, STAFF, makeRow } from './helpers/fake-server';

installStoreHooks();

afterEach(() => {
  setPushSubscribed(false);
  resetSyncExtras();
});

function bootWith(server: FakeServer, route: AlertRoute) {
  const shown: SystemNotice[] = [];
  const notifier: AlertNotifier = {
    plan: () => ({ route, skip: new Set<string>() }),
    setActive: () => undefined,
    show: async (alert, rowOf, sources) => {
      shown.push(systemNotice(alert, rowOf, sources));
      return true;
    },
    close: () => undefined,
    closeAll: () => undefined,
  };
  const booted = boot(server, {}, (env) => {
    env.notifier = () => notifier;
  });
  return { ...booted, shown };
}

describe('Web Push covers the page notification', () => {
  it('subscribed, app in the background: no page notification (the push carries it), no toast', async () => {
    const mine = makeRow(4, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { s, shown } = bootWith(server, 'system');
    setPushSubscribed(true);
    await ready();
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(shown).toEqual([]);
    expect(s().toasts).toEqual([]);
  });

  it('subscribed, app in front: the toast as before (the worker showed nothing)', async () => {
    const mine = makeRow(4, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { s, shown } = bootWith(server, 'toast');
    setPushSubscribed(true);
    await ready();
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(shown).toEqual([]);
    expect(s().toasts.map((t) => t.title)).toEqual(['LP-1004 · T.R. is in medical']);
  });

  it('not subscribed: the page notification as before (v2.5 A52)', async () => {
    const mine = makeRow(4, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { shown } = bootWith(server, 'system');
    await ready();
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(shown.map((n) => n.title)).toEqual(['LP-1004 · In medical']);
  });
});

describe('the Activity count rides on sync', () => {
  it('the first page of a poll publishes activityUnread (an older server: nothing)', async () => {
    const server = new FakeServer([makeRow(1)]);
    bootWith(server, 'toast');
    await ready();
    expect(lastActivityUnread()).toBeNull();
  });

  it('a server with Activity: the count and ids reach the bell on every poll', async () => {
    const server = new FakeServer([makeRow(1)]);
    server.syncExtras = { activityUnread: 2, activityUnreadIds: ['a', 'b'] };
    bootWith(server, 'toast');
    await ready();
    expect(lastActivityUnread()).toEqual({ count: 2, ids: ['a', 'b'] });
    server.syncExtras = { activityUnread: 0, activityUnreadIds: [] };
    await advance(6_000);
    expect(lastActivityUnread()).toEqual({ count: 0, ids: [] });
  });
});
