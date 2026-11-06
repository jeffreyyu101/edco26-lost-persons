// Alerts as system notifications through the real store (v2.5 A52): in the background an alert is one
// system notification and no toast or chime; in front it is the toast + chime as before; never both. The
// (id, rowVersion) dedupe and the 3+ combine rule hold for notifications too, and a notification whose
// alert is out of date is closed like its toast. Fake notifier; synthetic rows only.
import { describe, expect, it } from 'vitest';
import type { AlertEvent } from '@/lib/client/store-contract';
import type { AlertNotifier, AlertRoute, SystemNotice } from '@/lib/client/system-notify';
import { STATUS } from '@/lib/domain';
import { advance } from './helpers/env';
import { boot, finish, installStoreHooks, ready } from './helpers/boot';
import { FakeServer, STAFF, makeRow } from './helpers/fake-server';

installStoreHooks();

function fakeNotifier(initial: AlertRoute = 'system') {
  const n = {
    route: initial,
    works: true,
    shown: [] as SystemNotice[],
    closed: [] as Array<{ tag: string; key: string | null | undefined }>,
    closedAll: 0,
  };
  const notifier: AlertNotifier = {
    route: () => n.route,
    show: async (notice) => {
      if (!n.works) return false;
      n.shown.push(notice);
      return true;
    },
    close: (tag, key) => {
      n.closed.push({ tag, key });
    },
    closeAll: () => {
      n.closedAll += 1;
    },
  };
  return { n, notifier };
}

function bootWith(server: FakeServer, route: AlertRoute = 'system') {
  const fake = fakeNotifier(route);
  const booted = boot(server, {}, (env) => {
    env.notifier = () => fake.notifier;
  });
  const heard: AlertEvent[] = [];
  booted.store.actions.subscribeAlerts((e) => heard.push(e));
  return { ...booted, ...fake, heard };
}

const alertTitles = (s: () => { toasts: readonly { title: string }[] }) => s().toasts.map((t) => t.title);

describe('alerts in the background are system notifications', () => {
  it('my request answered: one notification, no toast and no chime; the overlap re-delivery adds nothing', async () => {
    const mine = makeRow(4, { firstName: 'Sofia', lastName: 'Lopez', reportingLocation: 'FA 3 – Kinetic', contactPhone: '4075550100', createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { s, n, heard } = bootWith(server);
    await ready();
    expect(n.shown).toEqual([]); // the first sync is the baseline
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(n.shown).toEqual([
      {
        title: 'LP-1004 · In medical',
        body: 'S.L. · FA 3\nBring the friend to Main Med',
        tag: mine.id,
        url: `/?r=${mine.id}`,
        key: `${mine.id}:2`,
        requireInteraction: true,
      },
    ]);
    expect(s().toasts).toEqual([]);
    expect(heard).toEqual([]);
    await advance(6_000);
    expect(n.shown).toHaveLength(1);
  });

  it('new requests (bell on): one notification each; 3 or more at once are one "3 new requests"', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { a, s, n } = bootWith(server);
    await ready();
    a.setPref('bell', true);
    server.put(makeRow(21, { caseNumber: 1014 }));
    await advance(6_000);
    expect(n.shown.map((x) => [x.title, x.body])).toEqual([['New request · LP-1014', 'T.R. · FA 4']]);
    server.put(makeRow(22));
    server.put(makeRow(23));
    server.put(makeRow(24));
    await advance(6_000);
    expect(n.shown.at(-1)).toMatchObject({ title: '3 new requests', body: 'LP-1022, LP-1023, LP-1024', tag: 'lp-alerts', url: '/' });
    expect(n.shown).toHaveLength(2);
    expect(s().toasts).toEqual([]);
  });

  it('in front, the toast + chime as before, and an older notification of that request is closed', async () => {
    const mine = makeRow(4, { firstName: 'Sofia', lastName: 'Lopez', createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { s, n, heard } = bootWith(server);
    await ready();
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(n.shown).toHaveLength(1);
    // Back in front: the changed answer is a toast, and the stale "In medical" notification goes.
    n.route = 'toast';
    server.change(mine.id, { status: STATUS.notInMedical });
    await advance(6_000);
    expect(alertTitles(s)).toEqual(['LP-1004 · S.L. — not in medical']);
    expect(heard.map((e) => e.title)).toEqual(['LP-1004 · S.L. — not in medical']);
    expect(n.shown).toHaveLength(1);
    expect(n.closed).toEqual([{ tag: mine.id, key: `${mine.id}:2` }]);
  });

  it('a notification that could not be shown falls back to the toast + chime', async () => {
    const mine = makeRow(4, { firstName: 'Sofia', lastName: 'Lopez', createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { s, n, heard } = bootWith(server);
    await ready();
    n.works = false;
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(alertTitles(s)).toEqual(['LP-1004 · S.L. is in medical']);
    expect(heard).toHaveLength(1);
  });

  it('an "In medical" notification closes once the row leaves In medical without an alert (my own Reunited)', async () => {
    const mine = makeRow(4, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { a, n } = bootWith(server);
    await ready();
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(n.shown).toHaveLength(1);
    await finish(a.setStatus(mine.id, STATUS.reunited, 'reunite'));
    expect(n.closed).toEqual([{ tag: mine.id, key: `${mine.id}:2` }]);
  });

  it('a later change of the same request replaces its notification; only the old change is ever closed', async () => {
    const mine = makeRow(4, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { n } = bootWith(server);
    await ready();
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    server.change(mine.id, { status: STATUS.waiting }); // the liaison's Undo, seen on the next poll
    await advance(6_000);
    expect(n.shown.map((x) => [x.title, x.tag, x.key])).toEqual([
      ['LP-1004 · In medical', mine.id, `${mine.id}:2`],
      ['LP-1004 · Waiting for check', mine.id, `${mine.id}:3`],
    ]);
    // The out-of-date "In medical" may be closed by its own key; the new one never is.
    expect(n.closed.every((c) => c.tag === mine.id && c.key === `${mine.id}:2`)).toBe(true);
  });

  it('signing out closes every notification of the app', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { a, n } = bootWith(server);
    await ready();
    expect(await finish(a.signOut())).toEqual({ ok: true });
    expect(n.closedAll).toBeGreaterThanOrEqual(1);
  });
});
