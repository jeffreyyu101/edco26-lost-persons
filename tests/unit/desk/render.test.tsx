// Server renders of the desk shell (components/desk) against the stub store: the frame's slots, the
// sidebar / rail with live counts and the current view, the top bar and the pane header. Synthetic only.
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeskFrame } from '@/components/desk/DeskFrame';
import { DeskNav, DeskPane, DeskTop } from '@/components/desk/DeskChrome';
import { useInDesk } from '@/components/desk/desk-context';
import { ALL_VIEW, type MainView } from '@/components/desk/views';
import { parseView } from '@/lib/client/nav';
import { viewCounts } from '@/lib/client/selectors';
import { StoreContext, type AppStore, type StoreState } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';
import { stubRows } from '@/lib/client/stub-data';

const NOW = Date.parse('2026-11-07T03:10:00Z');

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

  it('lists the views with live counts, a divider, Dashboard, Alerts and the person', () => {
    const store = storeWith((s) => ({ ...s, myIds: new Set() }));
    const html = render(<DeskNav main={ALL_VIEW} />, store);
    const sidebar = text(html.slice(html.indexOf('data-testid="desk-sidebar"'), html.indexOf('data-testid="desk-rail"')));
    expect(sidebar).toContain('Is my friend in medical?');
    expect(sidebar).toContain(`All requests ${counts.all}`);
    expect(sidebar).toContain(`Pending ${counts.pending}`);
    expect(sidebar).toContain('My requests');
    expect(sidebar).toContain('Dashboard');
    expect(sidebar).toContain('Alerts');
    expect(sidebar).toContain('Dana Kim');
    expect(sidebar).toContain('Dispatch');
    expect(html).toContain('href="/?view=pending"');
    expect(html).toContain('href="/?dashboard=1"');
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
    // The current view is marked in the sidebar and in the rail.
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(2);
    expect(html).toMatch(/href="\/"[^>]*aria-current="page"/);
  });

  it('marks Pending, then Dashboard, as current; search marks nothing', () => {
    expect(render(<DeskNav main={main('view=pending')} />)).toMatch(/href="\/\?view=pending"[^>]*aria-current="page"/);
    expect(render(<DeskNav main={main('dashboard=1')} />)).toMatch(/href="\/\?dashboard=1"[^>]*aria-current="page"/);
    expect(render(<DeskNav main={main('q=kay')} />)).not.toContain('aria-current');
  });

  it('the rail names each icon and badges Pending with its count', () => {
    const html = render(<DeskNav main={ALL_VIEW} />);
    const rail = html.slice(html.indexOf('data-testid="desk-rail"'));
    expect(rail).toContain('aria-label="All requests"');
    expect(rail).toContain(`aria-label="Pending ${counts.pending}"`);
    expect(rail).toContain('aria-label="My requests"');
    expect(rail).toContain('aria-label="Dashboard"');
    expect(rail).toMatch(/aria-label="Alerts" aria-pressed="false"/);
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
