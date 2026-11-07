// The request's status block in Pending v8 (Brian, 2026-11-06 afternoon; design/screens/pending-v8.html
// "The request"): In medical shows who answered and when, and nothing else (the "<friend> heading to Main
// Med" line is gone), then where medical has them (a pin, the location and a pencil, or "+ Location").
// Waiting, Not located and the closed states are unchanged. Server renders against the stub store.
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProfileView } from '@/components/profile/ProfileView';
import type { RequestSummary } from '@/lib/api-types';
import { StoreContext, type AppStore } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';
import { stubId } from '@/lib/client/stub-data';
import { STATUS } from '@/lib/domain';

const NOW = Date.now();

function store(patch: (row: RequestSummary) => RequestSummary = (r) => r, id = stubId(1004)): AppStore {
  const base = createStubStore({ eventTimezone: 'America/New_York', now: NOW });
  const state = base.getState();
  const confirmed = new Map(state.confirmed);
  confirmed.set(id, patch(confirmed.get(id)!));
  const next = { ...state, confirmed };
  return { getState: () => next, subscribe: () => () => {}, actions: base.actions };
}

const render = (s: AppStore, node: ReactNode) =>
  renderToString(
    <Theme>
      <StoreContext.Provider value={s}>{node}</StoreContext.Provider>
    </Theme>,
  );

/** The status block, through the end of its location row (or its status row). */
function statusBlock(html: string): string {
  const i = html.indexOf('data-testid="status-block"');
  expect(i).toBeGreaterThan(0);
  const end = html.indexOf('Missing person', i);
  return html.slice(html.lastIndexOf('<div', i), end);
}

const text = (html: string) =>
  html
    .replace(/<svg[^]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/<!-- -->/g, '')
    .replace(/\s+/g, ' ')
    .trim();

describe('the status block (Pending v8)', () => {
  it('In medical: the label, then only "who answered · when"; no "heading to Main Med"', () => {
    // 1004 S.L. is In medical, answered by Rae Chen 3 minutes ago; Jess T. is the friend.
    const html = render(store(), <ProfileView id={stubId(1004)} />);
    const block = statusBlock(html);
    expect(block).toContain('data-tone="green"');
    expect(text(block)).toMatch(/^Located · friend coming Rae Chen · \d{1,2}:\d{2}( [AP]M)? Location$/);
    expect(html).not.toMatch(/heading to Main Med|heading over/);
    expect(html).not.toContain('Jess T. heading');
  });

  it('In medical with no location: a quiet "+ Location" row that adds one', () => {
    const block = statusBlock(render(store(), <ProfileView id={stubId(1004)} />));
    expect(block).toMatch(/<button[^>]*aria-label="Add location"[^>]*data-testid="location-row"/);
    expect(text(block)).toMatch(/Location$/);
  });

  it('In medical with a location: the pin, "Chair 14" and the pencil, one button that edits it', () => {
    const block = statusBlock(render(store((r) => ({ ...r, medicalLocation: 'Chair 14' })), <ProfileView id={stubId(1004)} />));
    expect(block).toMatch(/<button[^>]*aria-label="Chair 14, edit location"[^>]*data-testid="location-row"/);
    expect(block).toMatch(/lucide-map-pin[^]*>Chair 14<\/span>[^]*lucide-pencil/);
  });

  it('offline: the location row looks disabled (edits need a connection)', () => {
    const base = store();
    const offline: AppStore = { ...base, getState: () => ({ ...base.getState(), connection: 'offline' }) };
    expect(statusBlock(render(offline, <ProfileView id={stubId(1004)} />))).toMatch(/aria-disabled="true"[^>]*data-disabled=""[^>]*data-testid="location-row"/);
  });

  it('Waiting, Not located and closed requests have no location row, even with one saved', () => {
    for (const n of [1012, 1009, 1003]) {
      const s = store((r) => ({ ...r, medicalLocation: 'Chair 14' }), stubId(n));
      const block = statusBlock(render(s, <ProfileView id={stubId(n)} />));
      expect(block, String(n)).not.toContain('location-row');
      expect(block, String(n)).not.toContain('Chair 14');
    }
    // The Waiting block still has its wait badge and "Logged …".
    const waiting = statusBlock(render(store(undefined, stubId(1012)), <ProfileView id={stubId(1012)} />));
    expect(waiting).toContain('data-testid="wait-badge"');
    expect(text(waiting)).toMatch(/^Waiting for check Logged /);
    expect(STATUS.waiting).toBe('Added');
  });
});
