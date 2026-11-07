// Change answer and Undo (design/DECISIONS.md v2.2 "Change answer and Undo", Brian + Jeffrey 2026-11-06: "if
// someone accidentally sets an in medical state then it's easy to undo and also set back to pending").
//   * Change answer opens a menu: the other answer, then Back to Waiting for check (kind 'change').
//   * Every answer path (profile buttons, Pending cards, the Change answer menu) offers Undo, for 10 s.
// The menu's choices are pure (change-answer.ts); the saves go through the real store against the fake API;
// the footer is server-rendered against the stub store. Synthetic data only.
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProfileView } from '@/components/profile/ProfileView';
import { BACK_TO_WAITING, changeAnswerChoices } from '@/components/profile/change-answer';
import type { RequestSummary } from '@/lib/api-types';
import { UNDO_MS } from '@/lib/client/constants';
import { StoreContext, type AppStore } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';
import { stubRows } from '@/lib/client/stub-data';
import { STATUS, STATUSES, STATUS_META, canTransition, primaryActions, undoTarget, type SettableStatus, type StatusKind } from '@/lib/domain';
import { advance } from '../client/helpers/env';
import { boot, finish, installStoreHooks, ready } from '../client/helpers/boot';
import { FakeServer, makeRow } from '../client/helpers/fake-server';

describe('changeAnswerChoices', () => {
  it('In medical: Not found, then Back to Waiting for check', () => {
    expect(changeAnswerChoices(STATUS.inMedical)).toEqual([
      { to: STATUS.notInMedical, label: 'Not found', kind: 'change' },
      { to: STATUS.waiting, label: 'Back to Waiting for check', kind: 'change' },
    ]);
    expect(BACK_TO_WAITING).toBe('Back to Waiting for check');
  });

  it('Not found in medical (closed and grey since v2.2): In medical, then Back to Waiting for check', () => {
    expect(changeAnswerChoices(STATUS.notInMedical)).toEqual([
      { to: STATUS.inMedical, label: 'In medical', kind: 'change' },
      { to: STATUS.waiting, label: 'Back to Waiting for check', kind: 'change' },
    ]);
  });

  it('legacy Bring friend: only the moves lp_set_status allows (it has no way back to Waiting)', () => {
    expect(canTransition(STATUS.legacyBringFriend, STATUS.waiting)).toBe(false);
    expect(changeAnswerChoices(STATUS.legacyBringFriend)).toEqual([{ to: STATUS.notInMedical, label: 'Not found', kind: 'change' }]);
  });

  it('nothing for Waiting, the closed statuses or an unknown legacy value', () => {
    for (const status of [STATUS.waiting, STATUS.reunited, STATUS.discharged, STATUS.cancelled, 'Found – Transported', '']) {
      expect(changeAnswerChoices(status), status).toEqual([]);
    }
  });

  it('every status with a Change answer button has a menu, and every choice and its Undo is an allowed move', () => {
    for (const status of STATUSES) {
      const hasButton = primaryActions(status).some((a) => a.kind === 'change');
      const choices = changeAnswerChoices(status);
      expect(choices.length > 0, status).toBe(hasButton);
      for (const c of choices) {
        expect(canTransition(status, c.to), `${status} → ${c.to}`).toBe(true);
        const back = undoTarget(status);
        expect(back && canTransition(c.to, back), `Undo ${c.to} → ${back}`).toBe(true);
      }
    }
  });
});

describe('Undo on every answer path (the real store)', () => {
  installStoreHooks();
  const statusPosts = (server: FakeServer) =>
    server.requests('POST', '/api/requests/').filter((r) => r.path.endsWith('/status')).map((r) => r.body as { status: string; expectedVersion: number; kind: string });

  it('UNDO_MS is 10 s (was 6 s)', () => {
    expect(UNDO_MS).toBe(10_000);
  });

  // [from, to, kind, snackbar text]: the profile buttons and Pending cards (answer, reunite) and the menu (change).
  // (Pending v9.1) A Not found that closes the request says so: "T.R. closed · not in medical" (the status label).
  const closed = `T.R. closed · ${STATUS_META[STATUS.notInMedical].label.toLowerCase()}`;
  const paths: Array<[string, SettableStatus, StatusKind, string]> = [
    [STATUS.waiting, STATUS.notInMedical, 'answer', closed],
    [STATUS.waiting, STATUS.inMedical, 'answer', 'LP-1001 · In medical'],
    [STATUS.inMedical, STATUS.reunited, 'reunite', 'LP-1001 · Reunited'],
    [STATUS.inMedical, STATUS.notInMedical, 'change', closed],
    [STATUS.inMedical, STATUS.waiting, 'change', 'LP-1001 · Waiting for check'],
    [STATUS.notInMedical, STATUS.inMedical, 'change', 'LP-1001 · In medical'],
    [STATUS.notInMedical, STATUS.waiting, 'change', 'LP-1001 · Waiting for check'],
  ];

  for (const [from, to, kind, label] of paths) {
    it(`${from} → ${to} (${kind}) offers Undo for 10 s, and Undo puts it back to ${from}`, async () => {
      const row = makeRow(1, { status: from, rowVersion: 3 });
      const server = new FakeServer([row]);
      const { a, s } = boot(server);
      await ready();
      const res = await finish(a.setStatus(row.id, to, kind));
      expect(res).toMatchObject({ ok: true, changed: true });
      expect(statusPosts(server).at(-1)).toEqual({ status: to, expectedVersion: 3, kind });
      expect(s().confirmed.get(row.id)?.status).toBe(to);
      expect(s().snackbar?.message).toBe(label);

      // Still there just before 10 s (the old 6 s has long passed).
      await advance(UNDO_MS - 100);
      const snack = s().snackbar;
      expect(snack?.message).toBe(label);

      const undone = await finish(a.undo(snack?.id ?? ''));
      expect(undone).toMatchObject({ ok: true, changed: true });
      expect(statusPosts(server).at(-1)).toEqual({ status: from, expectedVersion: 4, kind: 'undo' });
      expect(s().confirmed.get(row.id)?.status).toBe(from);
      expect(s().snackbar).toBeNull();
    });
  }

  it('the Undo bar closes at 10 s', async () => {
    const row = makeRow(1, { status: STATUS.inMedical });
    const server = new FakeServer([row]);
    const { a, s } = boot(server);
    await ready();
    await finish(a.setStatus(row.id, STATUS.waiting, 'change'));
    const snack = s().snackbar;
    expect(snack).not.toBeNull();
    await advance(UNDO_MS);
    expect(s().snackbar).toBeNull();
    expect(await a.undo(snack?.id ?? '')).toBeNull(); // expired
    expect(statusPosts(server).map((p) => p.kind)).toEqual(['change']);
  });

  it('no Undo when another liaison had already set the same status (changed: false)', async () => {
    const row = makeRow(1, { status: STATUS.inMedical });
    const server = new FakeServer([row]);
    const { a, s } = boot(server);
    await ready();
    server.change(row.id, { status: STATUS.waiting });
    await advance(6_000); // the next poll brings it in
    const res = await finish(a.setStatus(row.id, STATUS.waiting, 'change'));
    expect(res).toMatchObject({ ok: true, changed: false });
    expect(s().snackbar).toBeNull();
  });
});

describe('the profile footer', () => {
  const NOW = Date.now();
  const rows = stubRows(NOW);
  const withStatus = (status: string) => rows.find((r) => r.status === status) as RequestSummary;

  function render(node: ReactNode): string {
    const base = createStubStore({ eventTimezone: 'America/New_York', now: NOW });
    const state = base.getState();
    const store: AppStore = { getState: () => state, subscribe: () => () => {}, actions: base.actions };
    return renderToString(
      <Theme>
        <StoreContext.Provider value={store}>{node}</StoreContext.Provider>
      </Theme>,
    );
  }
  const footer = (html: string): string => {
    const i = html.indexOf('data-testid="profile-actions"');
    return i < 0 ? '' : html.slice(html.lastIndexOf('<div', i), html.indexOf('</div>', i));
  };
  const buttons = (bar: string) => bar.match(/<button[^>]*>/g) ?? [];

  it('In medical: Change answer (a menu button) and Reunited', () => {
    const bar = footer(render(<ProfileView id={withStatus(STATUS.inMedical).id} />));
    expect(bar).toContain('data-layout="one-two"');
    const [change, reunited, ...more] = buttons(bar);
    expect(more).toEqual([]);
    expect(change).toContain('data-testid="change-answer"');
    expect(change).toContain('aria-haspopup="menu"');
    expect(change).toContain('aria-expanded="false"');
    expect(reunited).not.toContain('aria-haspopup');
    expect(bar).toContain('>Reunited<');
  });

  it('Not found in medical: Change answer only, as a menu button', () => {
    const bar = footer(render(<ProfileView id={withStatus(STATUS.notInMedical).id} />));
    expect(bar).toContain('data-layout="one"');
    const [change, ...more] = buttons(bar);
    expect(more).toEqual([]);
    expect(change).toContain('data-testid="change-answer"');
    expect(change).toContain('aria-haspopup="menu"');
  });

  it('Waiting: the two answer buttons, no menu', () => {
    const bar = footer(render(<ProfileView id={withStatus(STATUS.waiting).id} />));
    expect(bar).toContain('data-layout="two"');
    expect(buttons(bar)).toHaveLength(2);
    expect(bar).not.toContain('aria-haspopup');
    // (Pending v9.1) The left answer of a request never held: the first Not found, which holds it.
    expect(bar).toContain('>Not found yet<');
    expect(bar).toContain('aria-label="Not found yet. Keeps this request open and schedules a recheck"');
    expect(bar).toContain('>In medical<');
    // The answer button is the short verb; the status it sets reads "Not found in medical".
    expect(bar).not.toContain('Not found in medical');
  });

  it('in the desk pane: the same actions right after the status block, before the details, two equal halves', () => {
    const html = render(<ProfileView id={withStatus(STATUS.inMedical).id} presentation="panel" />);
    const status = html.indexOf('data-testid="status-block"');
    const actions = html.indexOf('data-testid="profile-actions"');
    expect(status).toBeGreaterThan(0);
    expect(actions).toBeGreaterThan(status);
    expect(actions).toBeLessThan(html.indexOf('Missing person'));
    expect(html.indexOf('data-testid="profile-actions"', actions + 1)).toBe(-1);
    const bar = footer(html);
    expect(bar).toContain('data-layout="two"');
    const [change, reunited, ...more] = buttons(bar);
    expect(more).toEqual([]);
    expect(change).toContain('data-testid="change-answer"');
    expect(change).toContain('aria-haspopup="menu"');
    expect(reunited).not.toContain('aria-haspopup');
    // The phone keeps its bar at the foot, after the main content.
    const page = render(<ProfileView id={withStatus(STATUS.inMedical).id} />);
    expect(page.indexOf('data-testid="profile-actions"')).toBeGreaterThan(page.indexOf('</main>'));
  });
});
