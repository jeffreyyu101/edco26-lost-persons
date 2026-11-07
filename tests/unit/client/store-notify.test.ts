// Alerts as system notifications through the real store (v2.5 A52): in the background an alert is one
// system notification and no toast or chime; in front it is the toast + chime as before; never both. The
// (id, rowVersion) dedupe and the 3+ combine rule hold for notifications too, and a notification whose
// alert is out of date is closed like its toast. Fake notifier; synthetic rows only.
import { describe, expect, it } from 'vitest';
import type { AlertEvent } from '@/lib/client/store-contract';
import { createNotifySystem, systemNotice, type AlertNotifier, type AlertRoute, type SystemNotice } from '@/lib/client/system-notify';
import { STATUS } from '@/lib/domain';
import { MemoryStorage, advance } from './helpers/env';
import { boot, finish, installStoreHooks, ready } from './helpers/boot';
import { FakeServer, STAFF, makeRow } from './helpers/fake-server';
import { fakeNotifyHost, fakeRegistration } from './helpers/notify-host';

installStoreHooks();

function fakeNotifier(initial: AlertRoute = 'system') {
  const n = {
    route: initial,
    /** Keys another tab already delivered. */
    elsewhere: new Set<string>(),
    works: true,
    shown: [] as SystemNotice[],
    closed: [] as Array<{ tag: string; key: string | null | undefined }>,
    closedAll: 0,
    planned: [] as string[][],
    active: [] as boolean[],
  };
  const notifier: AlertNotifier = {
    plan: (keys) => {
      n.planned.push([...keys]);
      return { route: n.route, skip: new Set(keys.filter((k) => n.elsewhere.has(k))) };
    },
    setActive: (on) => {
      n.active.push(on);
    },
    show: async (alert, rowOf, sources) => {
      // Built at once from the rows the store passes, as the real notifier does.
      const notice = systemNotice(alert, rowOf, sources);
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

describe('(F5) my request going on the "Not located yet" hold', () => {
  const RECHECK = '2026-11-07T04:40:00Z'; // 11:40 PM in New York
  const hold = { recheckAt: RECHECK, notFoundChecks: 1 };
  const undo = { recheckAt: null, notFoundChecks: 0 };

  it('in the background: one notification in the contract\'s words (no LP number), closed when the hold is undone', async () => {
    const mine = makeRow(4, { firstName: 'Sofia', lastName: 'Lopez', createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { s, n } = bootWith(server);
    await ready();
    server.change(mine.id, hold);
    await advance(6_000);
    expect(n.shown).toEqual([
      { title: 'S.L.', body: 'Not located yet · recheck 11:40 PM', tag: `lp-${mine.id}`, url: `/?r=${mine.id}`, key: `${mine.id}:2`, requireInteraction: false },
    ]);
    expect(s().toasts).toEqual([]);
    // The 10 s Undo lands after the alert: the request is plain Waiting for check again, status unchanged.
    server.change(mine.id, undo);
    await advance(6_000);
    expect(n.closed).toEqual([{ tag: mine.id, key: `${mine.id}:2` }]);
    expect(n.shown).toHaveLength(1);
  });

  it('in front: the toast "S.L." / "Not located yet · recheck 11:40 PM" goes when the hold is undone; an Undo that puts it back says "Not located yet" again', async () => {
    const mine = makeRow(4, { firstName: 'Sofia', lastName: 'Lopez', createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { s, heard } = bootWith(server, 'toast');
    await ready();
    server.change(mine.id, hold);
    await advance(6_000);
    expect(s().toasts.map((t) => [t.title, t.subtitle])).toEqual([['S.L.', 'Not located yet · recheck 11:40 PM']]);
    expect(heard.map((e) => e.title)).toEqual(['S.L.']);
    server.change(mine.id, undo);
    await advance(6_000);
    expect(s().toasts).toEqual([]);
    // Held again, closed by the second Not found, and that undone: the hold is back, and so is its alert.
    server.change(mine.id, hold);
    await advance(6_000);
    server.change(mine.id, { status: STATUS.notInMedical, recheckAt: null, notFoundChecks: 2 });
    await advance(6_000);
    expect(alertTitles(s)).toEqual(['LP-1004 · S.L. — not located']);
    server.change(mine.id, { status: STATUS.waiting, ...hold });
    await advance(6_000);
    expect(s().toasts.map((t) => [t.title, t.subtitle])).toEqual([['S.L.', 'Not located yet · recheck 11:40 PM']]);
  });
});

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
        title: 'S.L. · Located',
        body: 'FA 3\nBring the friend to Main Med',
        tag: `lp-${mine.id}`,
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
    expect(n.shown.map((x) => [x.title, x.body])).toEqual([['New request', 'T.R. · FA 4']]);
    server.put(makeRow(22));
    server.put(makeRow(23));
    server.put(makeRow(24));
    await advance(6_000);
    // Initials, never LP numbers (F4).
    expect(n.shown.at(-1)).toMatchObject({ title: '3 new requests', body: 'T.R., T.R., T.R.', tag: 'lp-alerts', url: '/' });
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
    // Back in front: the changed answer is a toast, and the stale "Located" notification goes.
    n.route = 'toast';
    server.change(mine.id, { status: STATUS.notInMedical });
    await advance(6_000);
    expect(alertTitles(s)).toEqual(['LP-1004 · S.L. — not located']);
    expect(heard.map((e) => e.title)).toEqual(['LP-1004 · S.L. — not located']);
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
    expect(alertTitles(s)).toEqual(['LP-1004 · S.L. located']);
    expect(heard).toHaveLength(1);
  });

  it('an "Located" notification closes once the row leaves In medical without an alert (my own Reunited)', async () => {
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
      ['T.R. · Located', `lp-${mine.id}`, `${mine.id}:2`],
      ['T.R. · Waiting for check', `lp-${mine.id}`, `${mine.id}:3`],
    ]);
    // The out-of-date "Located" may be closed by its own key; the new one never is.
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

describe('alerts across tabs of one browser (the store’s side)', () => {
  it('plans each batch with the (id, rowVersion) of its alerts', async () => {
    const mine = makeRow(4, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { n } = bootWith(server);
    await ready();
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(n.planned.at(-1)).toEqual([`${mine.id}:2`]);
  });

  it('another tab in front ("none"): no toast, no chime, no notification here; a stale one of this tab closes', async () => {
    const mine = makeRow(4, { createdBy: STAFF.dana.staff });
    const server = new FakeServer([mine]);
    const { s, n, heard } = bootWith(server);
    await ready();
    server.change(mine.id, { status: STATUS.inMedical });
    await advance(6_000);
    expect(n.shown).toHaveLength(1);
    n.route = 'none';
    server.change(mine.id, { status: STATUS.notInMedical });
    await advance(6_000);
    expect(n.shown).toHaveLength(1);
    expect(s().toasts).toEqual([]);
    expect(heard).toEqual([]);
    expect(n.closed).toEqual([{ tag: mine.id, key: `${mine.id}:2` }]);
  });

  it('an alert another tab already delivered shows nowhere here; the rest of the batch does (and only they count toward "3 new requests")', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { a, s, n, heard } = bootWith(server, 'toast');
    await ready();
    a.setPref('bell', true);
    const rows = [31, 32, 33].map((i) => makeRow(i, { caseNumber: 1000 + i }));
    n.elsewhere.add(`${rows[0]!.id}:1`);
    for (const r of rows) server.put(r);
    await advance(6_000);
    expect(alertTitles(s)).toEqual(['New request · LP-1032', 'New request · LP-1033']);
    expect(heard.map((e) => e.title)).toEqual(['New request · LP-1032', 'New request · LP-1033']);
    // In the background the same rule: one notification each, not "3 new requests".
    n.route = 'system';
    const more = [41, 42, 43].map((i) => makeRow(i, { caseNumber: 1000 + i }));
    n.elsewhere.add(`${more[2]!.id}:1`);
    for (const r of more) server.put(r);
    await advance(6_000);
    expect(n.shown.map((x) => x.title)).toEqual(['New request', 'New request']);
    expect(n.shown.map((x) => x.tag)).toEqual([`lp-${more[0]!.id}`, `lp-${more[1]!.id}`]);
  });

  it('tells the notifier when it is alerting: after the baseline sync, and no more once stopped', async () => {
    const server = new FakeServer([makeRow(1)]);
    const { n, stop } = bootWith(server);
    expect(n.active).toEqual([]);
    await ready();
    expect(n.active).toEqual([true]);
    stop();
    expect(n.active).toEqual([true, false]);
  });

  it('two real tabs: the focused one toasts and chimes, the background one shows nothing; then all in the background, one notification', async () => {
    const server = new FakeServer([makeRow(1)]);
    const registration = fakeRegistration();
    const storage = new MemoryStorage();
    const hostA = fakeNotifyHost({ permission: 'granted', registration, storage, readyNow: true });
    const hostB = fakeNotifyHost({ permission: 'granted', registration, storage, readyNow: true, window: { hidden: true, focused: false } });
    const sysA = createNotifySystem(hostA.host);
    const sysB = createNotifySystem(hostB.host);
    sysA.start();
    sysB.start();
    const A = boot(server, {}, (env) => {
      env.notifier = () => sysA;
    });
    const B = boot(server, {}, (env) => {
      env.notifier = () => sysB;
    });
    B.fe.setVisible(false);
    const heardA: AlertEvent[] = [];
    const heardB: AlertEvent[] = [];
    A.a.subscribeAlerts((e) => heardA.push(e));
    B.a.subscribeAlerts((e) => heardB.push(e));
    await ready();
    A.a.setPref('bell', true);
    B.a.setPref('bell', true);

    // The background tab happens to sync first; the focused tab on its next poll.
    const first = makeRow(51, { caseNumber: 1051 });
    server.put(first);
    B.a.syncNow();
    await advance(50);
    expect(B.s().confirmed.has(first.id)).toBe(true);
    expect(registration.shows).toEqual([]);
    await advance(6_000);
    expect(alertTitles(A.s)).toEqual(['New request · LP-1051']);
    expect(heardA).toHaveLength(1);
    expect(B.s().toasts).toEqual([]);
    expect(heardB).toEqual([]);
    expect(registration.shows).toEqual([]);

    // Another app gets the focus: both tabs are in the background. One notification, from whichever
    // tab polls first; the other tab adds nothing, now or when it comes back to the front.
    await hostA.setWindow({ focused: false }, 'blur');
    const second = makeRow(52, { caseNumber: 1052 });
    server.put(second);
    await advance(6_000);
    expect(registration.shows.map((x) => x.title)).toEqual(['New request']);
    B.a.syncNow();
    await advance(50);
    expect(B.s().confirmed.has(second.id)).toBe(true);
    await hostB.setWindow({ hidden: false, focused: true }, 'focus');
    expect(registration.shows).toHaveLength(1);
    expect(B.s().toasts).toEqual([]);
    expect(heardB).toEqual([]);
    expect(alertTitles(A.s)).toEqual(['New request · LP-1051']);
  });
});
