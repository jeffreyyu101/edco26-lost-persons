// Server renders of the desk shell (components/desk) against the stub store: the frame's slots, the
// sidebar with live counts and the current view, the top bar and the pane header. Synthetic only.
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DeskFrame } from '@/components/desk/DeskFrame';
import { BrandCard } from '@/components/list/BrandCard';
import { DeskNav, DeskPane, DeskTop } from '@/components/desk/DeskChrome';
import { useInDesk } from '@/components/desk/desk-context';
import { ALL_VIEW, type MainView } from '@/components/desk/views';
import { parseView } from '@/lib/client/nav';
import { viewCounts } from '@/lib/client/selectors';
import { StoreContext, type AppStore, type StoreState } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';
import { stubRows } from '@/lib/client/stub-data';

const NOW = Date.parse('2026-11-07T03:10:00Z');

// The stub store's last sync is NOW, and the live line goes stale 30 s after it on the real clock: pin Date to
// NOW so these renders do not turn "Reconnecting" once the wall clock passes 2026-11-07 03:10:30 UTC.
beforeAll(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
});

// No getServerState: a server render then reads the stub's data (as tests/unit/list-views.test.tsx does).
function storeWith(change: (s: StoreState) => StoreState = (s) => s): AppStore {
  const base = createStubStore({ eventTimezone: 'America/New_York', now: NOW });
  const state = change(base.getState());
  return { getState: () => state, subscribe: () => () => {}, actions: base.actions };
}

const render = (node: ReactNode, store: AppStore = storeWith()) =>
  renderToString(
    <Theme>
      <StoreContext.Provider value={store}>{node}</StoreContext.Provider>
    </Theme>,
  );

const main = (query: string) => parseView(new URLSearchParams(query)) as MainView;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

function Probe() {
  return <span data-probe={useInDesk() ? 'desk' : 'phone'} />;
}

describe('DeskFrame', () => {
  it('on the phone renders the view and empty, hidden desk slots', () => {
    const html = render(
      <DeskFrame desk={false}>
        <Probe />
      </DeskFrame>,
    );
    expect(html).toContain('data-probe="phone"');
    expect(html).toContain('data-desk-main=""');
    expect(html).not.toContain('data-desk=""');
    expect(html).not.toContain('data-pane=""');
    expect(html).not.toContain('inert');
  });

  it('on the desk tells the views, docks a pane and holds a form over the rest', () => {
    const html = render(
      <DeskFrame desk nav={<i data-slot="nav" />} top={<i data-slot="top" />} pane={<i data-slot="pane" />}>
        <Probe />
      </DeskFrame>,
    );
    expect(html).toContain('data-probe="desk"');
    expect(html).toContain('data-desk=""');
    expect(html).toContain('data-pane=""');
    for (const slot of ['nav', 'top', 'pane']) expect(html).toContain(`data-slot="${slot}"`);
    expect(html).not.toContain('inert');
    // No brand slot unless the shell passes one (All requests).
    expect(html).not.toContain('data-testid="desk-brand"');

    // The brand card opens the main column, above the top bar.
    const withBrand = render(
      <DeskFrame desk brand={<i data-slot="brand" />} top={<i data-slot="top" />}>
        <Probe />
      </DeskFrame>,
    );
    const mainAt = withBrand.indexOf('data-desk-main=""');
    const brandAt = withBrand.indexOf('data-testid="desk-brand"');
    expect(brandAt).toBeGreaterThan(mainAt);
    expect(withBrand.indexOf('data-slot="brand"')).toBeGreaterThan(brandAt);
    expect(withBrand.indexOf('data-slot="top"')).toBeGreaterThan(withBrand.indexOf('data-slot="brand"'));

    // The real row as the page draws it on the server (F1.1's compact row): its X has no handler of its own
    // (the slot forwards its click, [data-brand-hide]) and its logos load lazily.
    const real = render(
      <DeskFrame desk brand={<BrandCard logoLoading="lazy" />} onHideBrand={() => {}} top={<i data-slot="top" />}>
        <Probe />
      </DeskFrame>,
    );
    const slot = real.slice(real.indexOf('data-testid="desk-brand"'), real.indexOf('data-slot="top"'));
    expect(slot).toContain('data-testid="brand-card"');
    expect(slot).toMatch(/<button type="button" class="[^"]*hide[^"]*" aria-label="Hide header" data-brand-hide="" data-testid="brand-hide">/);
    // (Events) The event's logo (when it has one, client side) and Ground Control's: lazy; the stub's event has none.
    expect(slot.match(/loading="lazy"/g)).toHaveLength(1);
    expect(slot).not.toContain('edc-orlando');
    expect(slot).not.toContain('Built by');
    expect(slot).not.toMatch(/event op/i);

    const withForm = render(
      <DeskFrame desk form={<i data-slot="form" />}>
        <Probe />
      </DeskFrame>,
    );
    expect(withForm).toContain('data-slot="form"');
    // Inert is decided once mounted (a form that portals its own dialog leaves the layer empty and
    // covers nothing): tests/e2e/desk-shell.spec.ts checks it in a browser.
    expect(withForm).not.toContain('inert');
  });
});

describe('DeskNav', () => {
  const counts = viewCounts(stubRows(NOW), [], new Set(), null);

  it('(events) an archived event: the lockup has no live dot and does not say Live', () => {
    const lockOf = (html: string) => {
      const from = html.indexOf('data-testid="desk-live"');
      return html.slice(html.lastIndexOf('<button', from), html.indexOf('</button>', from));
    };
    const live = lockOf(render(<DeskNav main={ALL_VIEW} />, storeWith((s) => ({ ...s, myIds: new Set() }))));
    expect(live).toContain('data-state=');
    const archived = lockOf(render(<DeskNav main={ALL_VIEW} />, storeWith((s) => ({ ...s, myIds: new Set(), event: s.event && { ...s.event, stage: 'archived' } }))));
    expect(archived).not.toContain('data-state=');
    expect(archived).toContain('aria-label="Archived event. Tap to sync now"');
    expect(archived).not.toMatch(/>Live</);
  });

  it('one sidebar: the lockup, the views with live counts, a divider, Dashboard, then the person; no rail', () => {
    const store = storeWith((s) => ({ ...s, myIds: new Set() }));
    const html = render(<DeskNav main={ALL_VIEW} />, store);
    expect(html).not.toContain('desk-rail');
    expect(html.match(/data-testid="desk-sidebar"/g)).toHaveLength(1);
    const sidebar = text(html);
    // The logo lockup first: (events) the event's logo | Ground Control (decoration inside the sync button). The
    // hover rainbow is the event logo's (single-colour logos only, once its pixels are read in the browser).
    const lockup = html.slice(html.indexOf('data-testid="desk-live"'));
    expect(lockup).not.toContain('edc-orlando');
    expect(lockup.indexOf('src="/logos/ground-control.png"')).toBeGreaterThan(0);
    const withLogo = render(<DeskNav main={ALL_VIEW} />, storeWith((s) => ({ ...s, myIds: new Set(), event: s.event && { ...s.event, logoUrl: '/api/events/logo/local?v=1' } })));
    const lock2 = withLogo.slice(withLogo.indexOf('data-testid="desk-live"'));
    expect(lock2.indexOf('src="/api/events/logo/local?v=1"')).toBeGreaterThan(0);
    expect(lock2.indexOf('src="/logos/ground-control.png"')).toBeGreaterThan(lock2.indexOf('/api/events/logo/local'));
    expect(html.indexOf('data-testid="desk-live"')).toBeLessThan(html.indexOf('href="/"'));
    expect(sidebar).not.toContain('Is my friend in medical?');
    expect(sidebar).toContain(`All requests ${counts.all}`);
    expect(sidebar).toContain(`Pending ${counts.pending}`);
    expect(sidebar).toContain('My requests');
    expect(sidebar).toContain('Dashboard');
    expect(sidebar).toContain('Dana Kim');
    expect(sidebar).toContain('Dispatch');
    expect(html).toContain('href="/?view=pending"');
    expect(html).toContain('href="/?dashboard=1"');
    // The views, a divider, Dashboard, in this order, inside the "Views" landmark.
    const nav = html.slice(html.indexOf('aria-label="Views"'), html.indexOf('</nav>'));
    const at = (needle: string) => nav.indexOf(needle);
    expect(at('href="/"')).toBeGreaterThan(0);
    expect(at('href="/?view=pending"')).toBeGreaterThan(at('href="/"'));
    expect(at('href="/?view=mine"')).toBeGreaterThan(at('href="/?view=pending"'));
    expect(nav.indexOf('aria-hidden="true"></span>', at('href="/?view=mine"'))).toBeGreaterThan(0);
    expect(at('href="/?dashboard=1"')).toBeGreaterThan(at('href="/?view=mine"'));
    // Each item carries its tooltip (shown only while collapsed), hidden from assistive tech.
    for (const label of ['All requests', 'Pending', 'My requests', 'Dashboard']) {
      expect(html).toMatch(new RegExp(`aria-hidden="true">${label}</span></a>`));
    }
    // F4: Alerts and Activity are client-only slots (components/activity/slots.tsx, their own chunk), drawn
    // after hydration: the e2e specs check them (alerts.spec.ts, activity.spec.ts, desk-shell.spec.ts).
    expect(html).not.toMatch(/role="switch"/);
    // The current view is marked once.
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/href="\/"[^>]*aria-current="page"/);
    // The edge (a pointer shortcut: out of the tab order, hidden from assistive tech; the top bar has the toggle).
    expect(html).toMatch(/<button type="button" class="[^"]*" tabindex="-1" aria-hidden="true" data-testid="desk-sidebar-rail"><\/button>/);
    // No scrim unless it is open over the content.
    expect(html).not.toContain('desk-sidebar-scrim');
  });

  it('expanded on the server (the desktop) with nothing chosen; the id the top bar toggle controls', () => {
    const html = render(<DeskNav main={ALL_VIEW} />);
    expect(html).toMatch(/<div id="desk-sidebar" class="[^"]*" data-testid="desk-sidebar" data-state="expanded">/);
    const top = render(<DeskTop main={ALL_VIEW} />);
    expect(top).toMatch(
      /<button type="button" class="[^"]*lp-hit" aria-label="Toggle sidebar" aria-expanded="true" aria-controls="desk-sidebar" aria-keyshortcuts="Meta\+B Control\+B" data-testid="desk-sidebar-toggle">/,
    );
    // The toggle and its line come first in the bar, before the title.
    expect(top.indexOf('desk-sidebar-toggle')).toBeLessThan(top.indexOf('<h1'));
  });

  it('marks Pending, then Dashboard, as current; search marks nothing', () => {
    expect(render(<DeskNav main={main('view=pending')} />)).toMatch(/href="\/\?view=pending"[^>]*aria-current="page"/);
    expect(render(<DeskNav main={main('dashboard=1')} />)).toMatch(/href="\/\?dashboard=1"[^>]*aria-current="page"/);
    expect(render(<DeskNav main={main('q=kay')} />)).not.toContain('aria-current');
  });

  it('names each item by its label and count, the same collapsed (the label is only visually hidden then)', () => {
    const html = render(<DeskNav main={ALL_VIEW} />);
    // No aria-label on the items: the name is the label and the count the item shows.
    expect(html).not.toMatch(/<a [^>]*aria-label=/);
    expect(text(html)).toContain(`Pending ${counts.pending}`);
  });

  it('shows no counts until data has loaded', () => {
    const html = render(<DeskNav main={ALL_VIEW} />, storeWith((s) => ({ ...s, hasData: false })));
    expect(text(html)).not.toContain(`All requests ${counts.all}`);
    expect(html).toContain('aria-label="Syncing"');
  });
});

describe('DeskTop', () => {
  it('titles the view with its count, search with the "/" cap, New request with the "N" cap', () => {
    const html = render(<DeskTop main={main('view=pending')} />);
    const counts = viewCounts(stubRows(NOW), [], new Set(), null);
    expect(text(html)).toContain(`Pending ${counts.pending}`);
    expect(html).toMatch(/<h1[^>]*>Pending/);
    expect(html).toContain('aria-keyshortcuts="/"');
    expect(html).toMatch(/<button[^>]*aria-keyshortcuts="N"[^>]*>.*New request/);
    expect(html).toMatch(/<kbd[^>]*aria-hidden="true"[^>]*>\/<\/kbd>/);
    expect(html).toMatch(/<kbd[^>]*aria-hidden="true"[^>]*>N<\/kbd>/);
  });

  it('a filtered All counts what it shows; search shows the query and no count', () => {
    const filtered = render(<DeskTop main={main('status=Added')} />);
    const waiting = stubRows(NOW).filter((r) => r.status === 'Added').length;
    expect(text(filtered)).toContain(`All requests ${waiting}`);
    const search = render(<DeskTop main={main('q=kay')} />);
    expect(search).toMatch(/<h1[^>]*>Search<\/h1>/);
    expect(search).toContain('value="kay"');
    expect(search).toContain('data-searching=""');
  });

  it('the live line sits right after the title on every view (F1.2, live-indicator.html Desktop frame): minutes, Refresh now; no chip', () => {
    const synced = storeWith((s) => ({ ...s, lastSyncLocalAt: Date.now() - 5_000 }));
    for (const query of ['', 'view=pending', 'view=mine', 'q=kay', 'status=Added']) {
      const html = render(<DeskTop main={main(query)} />, synced);
      // Directly after the title, before search and New request.
      expect(html, query).toMatch(/<\/h1><div class="[^"]*live[^"]*" data-state="healthy" data-testid="live-indicator">/);
      expect(html.indexOf('data-testid="live-indicator"'), query).toBeLessThan(html.indexOf('data-testid="desk-new"'));
      expect(html, query).toMatch(/data-testid="live-text">Updated just now<\/span>/);
      expect(html, query).toContain('>List updated just now.</span>');
      expect(html, query).toContain('aria-label="Refresh now"');
      expect(html, query).not.toMatch(/\ds ago|seconds/);
    }
    // Before the first sync: the line keeps its place and reads "Updating…" (network fix 1d; it showed nothing before).
    expect(render(<DeskTop main={ALL_VIEW} />, storeWith((s) => ({ ...s, lastSyncLocalAt: null })))).toMatch(
      /<\/h1><div class="[^"]*live[^"]*" data-state="healthy" data-updating="" data-testid="live-indicator"><svg[^>]*class="[^"]*liveSpin[^"]*"[^>]*>(?:<path[^>]*><\/path>)+<\/svg><span[^>]*data-testid="live-text">Updating…<\/span><span[^>]*>Updating the list\.<\/span><\/div>/,
    );

    // Dashboard v4: no line, search, New or bell; an empty box after the title that the dashboard fills (who's on,
    // the range control).
    const dash = () => render(<DeskTop main={main('dashboard=1')} />, synced);
    expect(dash()).toMatch(/<h1[^>]*>Dashboard<\/h1><div class="[^"]*dashSlot[^"]*" data-testid="desk-dashboard-slot"><\/div>/);
    for (const gone of ['data-testid="live-indicator"', 'data-testid="desk-new"', 'aria-label="Search"']) expect(dash()).not.toContain(gone);
    // The old Offline / Retrying chip is gone (F1.1: the line replaces it).
    expect(dash()).not.toContain('dashboard-connection');
    expect(render(<DeskTop main={ALL_VIEW} />, synced)).not.toContain('dashboard-connection');
  });
});

describe('DeskPane', () => {
  it('heads the request with its LP number, previous / next, more actions and close', () => {
    const row = stubRows(NOW)[0]!;
    const html = render(
      <DeskPane id={row.id} main={ALL_VIEW}>
        <p>profile</p>
      </DeskPane>,
    );
    const lp = `LP-${String(row.caseNumber).padStart(4, '0')}`;
    expect(html).toContain(`aria-label="${lp}"`);
    expect(html).toContain(`>${lp}</span>`);
    expect(html).toContain('aria-label="Previous request" aria-keyshortcuts="K ArrowUp"');
    expect(html).toContain('aria-label="Next request" aria-keyshortcuts="J ArrowDown"');
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain('aria-label="Close" aria-keyshortcuts="Escape"');
    expect(html).toContain('<p>profile</p>');
    // The open row is highlighted in the list.
    expect(html).toContain(`[data-desk-main] [data-request-id="${row.id}"]{`);
  });
});
