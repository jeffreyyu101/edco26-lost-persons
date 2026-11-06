// Desk view model (components/desk/views.ts, nav-model.ts, breakpoints.ts). Synthetic only.
import { describe, expect, it } from 'vitest';
import { DESK_MIN, DESK_QUERY, DOCK_MIN, SIDEBAR_MIN, isDeskNow, layoutFor } from '@/components/desk/breakpoints';
import { NAV_LABEL, NAV_PARAMS, mainTitle, navKeyOf, neighbours } from '@/components/desk/nav-model';
import { ALL_VIEW, isFormView, isMainView, nextMainView, paneRequestId, type MainView } from '@/components/desk/views';
import { hrefFor, parseView } from '@/lib/client/nav';

const ID = '5eed0000-0000-4000-8000-000000001004';
const view = (query: string) => parseView(new URLSearchParams(query));

describe('breakpoints', () => {
  it('follows the responsive contract', () => {
    expect([DESK_MIN, DOCK_MIN, SIDEBAR_MIN]).toEqual([768, 1024, 1280]);
    expect(DESK_QUERY).toBe('(min-width: 768px)');
    expect(layoutFor(390)).toBe('phone');
    expect(layoutFor(767)).toBe('phone');
    expect(layoutFor(768)).toBe('tablet');
    expect(layoutFor(820)).toBe('tablet');
    expect(layoutFor(1023)).toBe('tablet');
    expect(layoutFor(1024)).toBe('laptop');
    expect(layoutFor(1180)).toBe('laptop');
    expect(layoutFor(1279)).toBe('laptop');
    expect(layoutFor(1280)).toBe('desktop');
    expect(layoutFor(1440)).toBe('desktop');
  });

  it('is the phone without a window (server, tests)', () => {
    expect(isDeskNow()).toBe(false);
  });
});

describe('which view goes where', () => {
  it('main views are the lists, search and the dashboard', () => {
    for (const q of ['', 'view=pending', 'view=mine', 'q=kay', 'dashboard=1', 'status=Added', 'post=FA%204%20%E2%80%93%20Oasis']) {
      expect(isMainView(view(q)), q).toBe(true);
    }
    for (const q of [`r=${ID}`, `r=${ID}&edit=person`, 'new=1', `outbox=${ID}`]) expect(isMainView(view(q)), q).toBe(false);
  });

  it('forms open over the desk; a request opens in the pane', () => {
    expect(isFormView(view('new=1'))).toBe(true);
    expect(isFormView(view(`r=${ID}&edit=all`))).toBe(true);
    expect(isFormView(view(`outbox=${ID}`))).toBe(true);
    expect(isFormView(view(`r=${ID}`))).toBe(false);
    expect(paneRequestId(view(`r=${ID}`))).toBe(ID);
    // Editing keeps the request in the pane behind the form.
    expect(paneRequestId(view(`r=${ID}&edit=person`))).toBe(ID);
    expect(paneRequestId(view('new=1'))).toBeNull();
    expect(paneRequestId(view('view=pending'))).toBeNull();
  });

  it('keeps the last list behind a request or a form, All for a deep link', () => {
    const pending = view('view=pending') as MainView;
    expect(nextMainView(view(`r=${ID}`), pending)).toBe(pending);
    expect(nextMainView(view('new=1'), pending)).toBe(pending);
    const mine = view('view=mine');
    expect(nextMainView(mine, pending)).toBe(mine);
    expect(nextMainView(view(`r=${ID}`), ALL_VIEW)).toBe(ALL_VIEW);
  });
});

describe('sidebar model', () => {
  it('labels, links and the active entry', () => {
    expect(NAV_LABEL).toEqual({ all: 'All requests', pending: 'Pending', mine: 'My requests', dashboard: 'Dashboard' });
    expect(hrefFor(NAV_PARAMS.all)).toBe('/');
    expect(hrefFor(NAV_PARAMS.pending)).toBe('/?view=pending');
    expect(hrefFor(NAV_PARAMS.mine)).toBe('/?view=mine');
    expect(hrefFor(NAV_PARAMS.dashboard)).toBe('/?dashboard=1');
    expect(navKeyOf(view('status=Added') as MainView)).toBe('all');
    expect(navKeyOf(view('view=pending') as MainView)).toBe('pending');
    expect(navKeyOf(view('dashboard=1') as MainView)).toBe('dashboard');
    expect(navKeyOf(view('q=x') as MainView)).toBeNull();
    expect(mainTitle(view('q=x') as MainView)).toBe('Search');
    expect(mainTitle(view('view=mine') as MainView)).toBe('My requests');
  });

  it('previous / next through the main column order', () => {
    const ids = ['a', 'b', 'c'];
    expect(neighbours(ids, 'b')).toEqual({ prev: 'a', next: 'c' });
    expect(neighbours(ids, 'a')).toEqual({ prev: null, next: 'b' });
    expect(neighbours(ids, 'c')).toEqual({ prev: 'b', next: null });
    // Not in the list (filtered out, or nothing selected yet): next is the first row.
    expect(neighbours(ids, 'z')).toEqual({ prev: null, next: 'a' });
    expect(neighbours(ids, null)).toEqual({ prev: null, next: 'a' });
    expect(neighbours([], 'a')).toEqual({ prev: null, next: null });
  });
});
