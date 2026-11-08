// Dashboard v4 (design/screens/dashboard-v4.html), server-rendered: the four zones in order, the status bar and its
// legend, Needs attention rows (glyph + case + tent + walk ETA + timer pill with its severity glyph), Speed medians
// with their badges, the calls header and recap; labels and values only, sentences only for screen readers; and the
// phone / desk chrome.
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DashboardContent, DashboardView } from '@/components/dashboard/DashboardView';
import { DeskContext } from '@/components/desk/desk-context';
import type { Stats } from '@/lib/api-types';
import { StoreContext, type AppStore, type StoreState } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';

function storeWith(patch: (s: StoreState) => StoreState = (s) => s): AppStore {
  const base = createStubStore({ eventTimezone: 'America/New_York', now: Date.now() });
  const state = patch(base.getState());
  return { getState: () => state, subscribe: () => () => {}, actions: base.actions };
}

const render = (store: AppStore, node: ReactNode) =>
  renderToString(
    <Theme>
      <StoreContext.Provider value={store}>{node}</StoreContext.Provider>
    </Theme>,
  );

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const at = (html: string, needle: string) => {
  const i = html.indexOf(needle);
  expect(i, needle).toBeGreaterThanOrEqual(0);
  return i;
};

/** The v4 mockup's night (synthetic, aggregates and case numbers only). */
function v4Stats(over: Partial<Stats> = {}): Stats {
  return {
    open: { waiting: 10, inMedical: 5 },
    notInMedical: 1,
    reunited: 32,
    discharged: 0,
    cancelled: 0,
    total: 48,
    longestWait: null,
    avgAnswerMinutes: null,
    avgReuniteMinutes: null,
    loggedLastHour: 6,
    byPost: [],
    recent: [],
    serverTime: new Date().toISOString(),
    range: { key: 'tonight', from: iso(600), step: 15, compare: true },
    live: { waiting: 6, pending: 4, located: 5 },
    attention: {
      total: 13,
      items: [
        { id: 'a', caseNumber: 1137, tent: 'FA 3', kind: 'located', since: iso(38), enroute: true, etaAt: new Date(Date.now() + 90_000).toISOString() },
        { id: 'b', caseNumber: 1136, tent: 'FA 4', kind: 'recheck', since: iso(15), enroute: false, etaAt: null },
        { id: 'c', caseNumber: 1142, tent: 'FA 3', kind: 'wait', since: iso(34), enroute: false, etaAt: null },
        { id: 'd', caseNumber: 1138, tent: 'FA 3', kind: 'recheck', since: iso(6), enroute: false, etaAt: null },
        { id: 'e', caseNumber: 1139, tent: 'FA 4', kind: 'located', since: iso(25), enroute: false, etaAt: null },
      ],
    },
    speed: [
      { key: 'firstCheck', target: 10, n: 40, median: 10.5, p90: 24, prevMedian: 12, byTent: { 'FA 4': 9, 'FA 3': 12, Other: null }, spark: [] },
      { key: 'located', target: 15, n: 30, median: 11.2, p90: 20, prevMedian: 14, byTent: { 'FA 4': 10, 'FA 3': 12, Other: null }, spark: [] },
      { key: 'reunited', target: 30, n: 32, median: 19.1, p90: 40, prevMedian: 25, byTent: { 'FA 4': 18, 'FA 3': 21, Other: null }, spark: [] },
    ],
    calls: { total: 48, prevTotal: 40, buckets: [] },
    heat: { step: 60, cols: [] },
    recap: { reunited: 32, notLocated: 1, fastest: 6.5, prevReunited: 21, prevNotLocated: 2, prevFastest: 4.9, lastReunionAt: iso(3) },
    team: [
      { team: 'medical', on: 6 },
      { team: 'dispatch', on: 2 },
      { team: 'base', on: 1 },
      { team: 'transpo', on: 0 },
    ],
    ...over,
  };
}

describe('Dashboard v4', () => {
  it('four zones in order: status, Needs attention, Speed, Calls (with the recap)', () => {
    const html = render(storeWith(), <DashboardContent stats={v4Stats()} range="tonight" />);
    expect(at(html, 'data-testid="status"')).toBeLessThan(at(html, 'data-testid="attention"'));
    expect(at(html, 'data-testid="attention"')).toBeLessThan(at(html, 'data-testid="speed"'));
    expect(at(html, 'data-testid="speed"')).toBeLessThan(at(html, 'data-testid="calls"'));
    expect(at(html, 'data-testid="calls"')).toBeLessThan(at(html, 'data-testid="recap"'));
  });

  it('status: Open 15, the bar Waiting → Pending → Located with boundary values, and a glyph beside every count', () => {
    const html = render(storeWith(), <DashboardContent stats={v4Stats()} range="tonight" />);
    expect(html).toMatch(/data-testid="open-count" aria-hidden="true">15</);
    expect(html).toContain('aria-label="Open 15: 6 waiting for a first check, 4 pending a re-check, 5 located, friend not here yet"');
    expect(html.match(/data-part="(\w+)"/g)).toEqual(['data-part="waiting"', 'data-part="pending"', 'data-part="located"']);
    expect(html).toMatch(/<span style="left:0%">0<\/span><span style="left:40%">6<\/span><span style="left:66\.6+%">10<\/span><span style="left:100%">15<\/span>/);
    for (const [k, n] of [['waiting', 6], ['pending', 4], ['located', 5]] as const) {
      expect(html).toMatch(new RegExp(`data-testid="status-${k}"><svg[^]*?<b aria-hidden="true">${n}</b>`));
    }
  });

  it('needs attention: the 5 most urgent with kind glyph, case, tent, walk ETA and a timer whose colour has a glyph; +8 more', () => {
    const html = render(storeWith(), <DashboardContent stats={v4Stats()} range="tonight" />);
    const rows = [...html.matchAll(/data-testid="attention-row" data-kind="(\w+)" data-sev="(\w+)"/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(rows).toEqual(['located:crit', 'recheck:crit', 'wait:crit', 'recheck:warn', 'located:warn']);
    expect(html).toMatch(/>1137<\/span><span class="[^"]*tchip[^"]*" aria-hidden="true">FA 3<\/span>/);
    expect(html).toMatch(/data-testid="attention-row"[^>]*><span[^>]*>Request 1137 at FA 3, located 38 minutes ago, friend not here yet, on the way, about 2 minutes out<\/span>/);
    expect(html).toMatch(/data-sev="crit" aria-hidden="true"><svg[^>]*><circle[^>]*fill="var\(--red-9\)"/);
    expect(html).toMatch(/data-sev="warn" aria-hidden="true"><svg[^>]*lucide-clock/);
    expect(html).toContain('+6:00');
    expect(html).toMatch(/data-testid="attention-more"[^>]*>\+<!-- -->8<!-- --> more/);
    expect(html).not.toMatch(/waiting \d+ minutes<\/span>/); // no sentence on screen
  });

  it('speed: three medians with their target badge (check or arrow, signed distance); no data reads "—"', () => {
    const html = render(storeWith(), <DashboardContent stats={v4Stats()} range="tonight" />);
    expect(html).toMatch(/data-testid="speed-firstCheck"[^]*?data-sev="warn"[^]*?lucide-arrow-up[^]*?\+0\.5[^]*?>10\.5<small>m<\/small>/);
    expect(html).toMatch(/data-testid="speed-located"[^]*?data-sev="ok"[^]*?lucide-check[^]*?−3\.8/);
    const none = render(storeWith(), <DashboardContent stats={v4Stats({ speed: [] })} range="tonight" />);
    expect(none.match(/>—</g)).toHaveLength(3);
  });

  it('calls and recap: the total, the night before as a dashed key, ↑ deltas, the last reunion as a ticking timer', () => {
    const html = render(storeWith(), <DashboardContent stats={v4Stats()} range="tonight" />);
    expect(html).toMatch(/data-testid="calls-total"[^>]*><b>48<\/b><span>calls<\/span>/);
    expect(html).toMatch(/class="[^"]*lk[^"]*"><\/i>\w{3}</);
    expect(html).toMatch(/data-testid="recap-reunited">32<\/b> reunited<span[^>]*aria-label="11 more than \w{3}"[^>]*>↑<!-- -->11/);
    expect(html).toMatch(/Fastest <b>6\.5m<\/b><span[^>]*aria-label="1\.6 minutes slower than \w{3}"/);
    expect(html).toMatch(/data-testid="recap-last"[^>]*>Last reunion <b>3:0\d<\/b> ago/);
    // Event: no night before, so no dashed key and no deltas.
    const ev = render(storeWith(), <DashboardContent stats={v4Stats({ range: { key: 'event', from: iso(3000), step: 60, compare: false } })} range="event" />);
    expect(ev).not.toMatch(/class="[^"]*\blk\b/);
    expect(ev).not.toContain('↑');
  });

  it('privacy: no names anywhere, only case numbers and tents', () => {
    const html = render(storeWith(), <DashboardContent stats={v4Stats({ recent: [{ id: 'x', caseNumber: 1, name: 'Jordan Diaz', status: 'Added', postShort: 'FA 4', updatedAt: iso(1) }] })} range="tonight" />);
    expect(html).not.toContain('Jordan');
  });

  it('a server before v4: Open from Waiting + In medical, an empty attention list, the old reunited count', () => {
    const { range: _r, live: _l, attention: _a, speed: _s, calls: _c, heat: _h, recap: _p, team: _t, ...old } = v4Stats();
    const html = render(storeWith(), <DashboardContent stats={old} range="tonight" />);
    expect(html).toMatch(/data-testid="open-count" aria-hidden="true">15</);
    expect(html).toContain('data-testid="attention-clear"');
    expect(html).toMatch(/data-testid="recap-reunited">32</);
  });

  it('phone: ‹ Dashboard, the range control (Tonight by default), the skeleton before the first stats; no helper line', () => {
    const html = render(storeWith(), <DashboardView />);
    expect(html).toMatch(/<h1[^>]*>Dashboard<\/h1>/);
    expect(html).toContain('aria-label="Back to requests"');
    expect(html).toMatch(/aria-label="Time range"/);
    expect(html).toMatch(/aria-checked="true"[^>]*>(<[^>]*>)*Tonight/);
    expect(html).toContain('data-testid="dashboard-loading"');
    expect(html).not.toContain('Updated');
    for (const connection of ['offline', 'error'] as const) {
      const off = render(storeWith((s) => ({ ...s, connection })), <DashboardView />);
      expect(off, connection).toContain('data-testid="connection-banner"');
    }
  });

  it('desk: no title row (the shell top bar has it, and the controls are portalled there); the banner stays', () => {
    const desk = render(
      storeWith((s) => ({ ...s, connection: 'offline' })),
      <DeskContext.Provider value>
        <DashboardView />
      </DeskContext.Provider>,
    );
    expect(desk).not.toContain('<h1');
    expect(desk).not.toContain('aria-label="Back to requests"');
    expect(desk).toContain('data-testid="connection-banner"');
    expect(desk).toContain('data-testid="dashboard-loading"');
  });
});
