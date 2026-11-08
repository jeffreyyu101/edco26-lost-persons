// Server renders of the dashboard (design/screens/polish-v7.html Dash / Laptop) against the stub store and
// mocked Stats: section order, the tiles and their numbers, Open by post busiest first, Recently updated rows,
// Performance ("None" for an empty value, "—" only while the stats request fails), the connection chip, and no
// Export CSV. Synthetic data only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DashboardContent, DashboardView } from '@/components/dashboard/DashboardView';
import { DeskContext } from '@/components/desk/desk-context';
import type { Stats } from '@/lib/api-types';
import { StoreContext, type AppStore, type StoreState } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';
import { STATUS } from '@/lib/domain';

// useNow() reads the real clock during a server render, so the stub is built around the real now.
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

/** The night from the v7 mockup (synthetic). */
function v7Stats(over: Partial<Stats> = {}): Stats {
  return {
    open: { waiting: 4, inMedical: 3 },
    notInMedical: 2,
    reunited: 2,
    discharged: 1,
    cancelled: 1,
    total: 13,
    longestWait: { id: '5eed0000-0000-4000-8000-000000001010', caseNumber: 1010, reportingLocation: 'FA 4 – Oasis', otherLocation: null, postShort: 'FA 4', minutes: 24 },
    avgAnswerMinutes: 9,
    avgReuniteMinutes: 18,
    loggedLastHour: 6,
    byPost: [
      { reportingLocation: 'FA 3 – Kinetic', otherLocation: null, postShort: 'FA 3', count: 3 },
      { reportingLocation: 'FA 4 – Oasis', otherLocation: null, postShort: 'FA 4', count: 3 },
      { reportingLocation: 'Command', otherLocation: null, postShort: 'Command', count: 0 },
      { reportingLocation: 'Base', otherLocation: null, postShort: 'Base', count: 0 },
      { reportingLocation: 'Other', otherLocation: 'Gate 9', postShort: 'Gate 9', count: 1 },
    ],
    recent: [
      { id: '5eed0000-0000-4000-8000-000000001007', caseNumber: 1007, name: 'Jordan Diaz', status: STATUS.inMedical, postShort: 'FA 4', updatedAt: iso(2) },
      { id: '5eed0000-0000-4000-8000-000000001009', caseNumber: 1009, name: 'A.N.', status: STATUS.notInMedical, postShort: 'FA 3', updatedAt: iso(6) },
      { id: '5eed0000-0000-4000-8000-000000001010', caseNumber: 1010, name: 'B.W.', status: STATUS.waiting, postShort: 'FA 4', updatedAt: iso(9) },
      { id: '5eed0000-0000-4000-8000-000000001006', caseNumber: 1006, name: null, status: STATUS.reunited, postShort: 'Command', updatedAt: iso(61) },
    ],
    serverTime: new Date().toISOString(),
    ...over,
  };
}

const at = (html: string, needle: string) => {
  const i = html.indexOf(needle);
  expect(i, needle).toBeGreaterThanOrEqual(0);
  return i;
};

/** The HTML of the element carrying data-testid="id" up to the next tile / row (good enough for asserts). */
const slice = (html: string, testId: string, len = 1600) => html.slice(at(html, `data-testid="${testId}"`), at(html, `data-testid="${testId}"`) + len);

describe('dashboard render', () => {
  it('global view order: tiles, Open by post, Recently updated, Performance; no Export CSV', () => {
    const html = render(storeWith(), <DashboardContent stats={v7Stats()} />);
    const tiles = at(html, 'aria-label="Totals"');
    const posts = at(html, '>Open by post<');
    const recent = at(html, 'aria-label="Recently updated"');
    const perf = at(html, '>Performance<');
    expect(tiles).toBeLessThan(posts);
    expect(posts).toBeLessThan(recent);
    expect(recent).toBeLessThan(perf);
    expect(html).not.toContain('Export CSV');
    expect(html).not.toContain('/api/export');
  });

  it('tiles: Open and Closed big, then Waiting, In medical, Not located, Reunited, with their numbers', () => {
    const html = render(storeWith(), <DashboardContent stats={v7Stats()} />);
    const order = ['tile-open', 'tile-closed', 'tile-waiting', 'tile-in-medical', 'tile-not-in-medical', 'tile-reunited'].map((id) => at(html, `data-testid="${id}"`));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toMatch(/data-testid="open-count"[^>]*>7</);
    expect(slice(html, 'tile-closed')).toMatch(/>Closed<\/span><\/span> <span[^>]*><span[^>]*>6</);
    expect(slice(html, 'tile-waiting')).toMatch(/>Waiting for check<\/span><\/span> <span[^>]*><span[^>]*>4</);
    expect(slice(html, 'tile-in-medical')).toMatch(/>Located<\/span><\/span> <span[^>]*><span[^>]*>3</);
    expect(slice(html, 'tile-not-in-medical')).toMatch(/>Not located<\/span><\/span> <span[^>]*><span[^>]*>2</);
    expect(slice(html, 'tile-reunited')).toMatch(/>Reunited<\/span><\/span> <span[^>]*><span[^>]*>2</);
    // Closed is not a filter (there is no closed-bucket view); every other tile opens a view.
    expect(html).toMatch(/<div[^>]*data-testid="tile-closed"/);
    for (const id of ['tile-open', 'tile-waiting', 'tile-in-medical', 'tile-not-in-medical', 'tile-reunited']) {
      expect(html).toMatch(new RegExp(`<button[^>]*data-testid="${id}"`));
    }
    // Not located is closed and grey: the grey × glyph, like the closed check on Reunited.
    expect(slice(html, 'tile-not-in-medical', 600)).toMatch(/data-glyph="notInMedical"[^>]*><circle[^>]*fill="var\(--gray-9\)"/);
    expect(slice(html, 'tile-reunited', 600)).toMatch(/data-glyph="closed"[^>]*><circle[^>]*fill="var\(--gray-9\)"/);
    expect(slice(html, 'tile-waiting', 600)).toContain('var(--blue-9)');
    expect(slice(html, 'tile-in-medical', 600)).toContain('var(--green-9)');
  });

  it('Open split bar: blue Waiting then green In medical, in proportion', () => {
    const html = render(storeWith(), <DashboardContent stats={v7Stats()} />);
    const split = slice(html, 'open-split', 400);
    expect(split).toMatch(/flex:4[^"]*background:var\(--blue-9\)/);
    expect(split).toMatch(/flex:3[^"]*background:var\(--green-9\)/);
    expect(split.indexOf('blue-9')).toBeLessThan(split.indexOf('green-9'));
  });

  it('Reunited shows "+1 discharged · 1 cancelled" only when either is non-zero', () => {
    const withSub = render(storeWith(), <DashboardContent stats={v7Stats()} />);
    // Non-breaking spaces inside each part, so a narrow tile wraps only after the "·".
    expect(slice(withSub, 'reunited-sub', 300)).toContain('+1\u00a0discharged\u00a0· 1\u00a0cancelled');
    expect(withSub).toContain('plus 1 discharged and 1 cancelled');
    const without = render(storeWith(), <DashboardContent stats={v7Stats({ discharged: 0, cancelled: 0, notInMedical: 1 })} />);
    expect(without).not.toContain('data-testid="reunited-sub"');
    expect(without).not.toContain('discharged');
    // Closed still adds them all up.
    expect(slice(without, 'tile-closed')).toMatch(/>Closed<\/span><\/span> <span[^>]*><span[^>]*>3</);
  });

  it('Open by post: busiest first, label above the bar, count in its own column, zero rows marked', () => {
    const html = render(storeWith(), <DashboardContent stats={v7Stats()} />);
    const labels = [...html.matchAll(/aria-label="([^"]+) (\d+) open"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(labels).toEqual(['FA 3 – Kinetic 3', 'FA 4 – Oasis 3', 'Other · Gate 9 1', 'Command 0', 'Base 0']);
    const zero = html.slice(at(html, 'aria-label="Command 0 open"') - 200, at(html, 'aria-label="Command 0 open"') + 400);
    expect(zero).toContain('data-zero=""');
    const busiest = html.slice(at(html, 'aria-label="FA 3 – Kinetic 3 open"') - 200, at(html, 'aria-label="FA 3 – Kinetic 3 open"') + 400);
    expect(busiest).not.toContain('data-zero');
    expect(busiest).toContain('width:100%');
    const gate = html.slice(at(html, 'aria-label="Other · Gate 9 1 open"'), at(html, 'aria-label="Other · Gate 9 1 open"') + 400);
    expect(gate).toContain('width:33.3%');
  });

  it('Recently updated: the number leftmost (no LP-), name, status glyph + label, and the updated time', () => {
    const html = render(storeWith(), <DashboardContent stats={v7Stats()} />);
    const recent = html.slice(at(html, 'aria-label="Recently updated"'), at(html, '>Performance<'));
    expect(recent).toContain('aria-label="Recently updated. Show all requests"');
    expect(recent).not.toContain('LP-');
    const row = recent.slice(at(recent, 'data-request-id="5eed0000-0000-4000-8000-000000001007"'));
    expect(row).toMatch(/^[^<]*><span[^>]*>1007<\/span> <span[^>]*>Jordan Diaz<\/span> <span[^>]*data-tone="green"[^>]*><svg[\s\S]*?<\/svg>Located<\/span> <span[^>]*>[12]m<\/span>/);
    // (useNow's clock is read when the module loads, so 2 minutes can read as 1.)
    // The name starts with exactly what the row shows (WCAG 2.5.3), then the sentence.
    expect(recent).toMatch(/aria-label="1007 Jordan Diaz Located ([12])m\. Located · friend coming, FA 4, updated \1 minutes? ago\."/);
    expect(recent).toMatch(/aria-label="1009 A\.N\. Not located ([56])m\. Not located, FA 3, updated \1 minutes ago\."/);
    // Closed rows are marked (greyed); Not located is one of them now.
    expect(recent).toMatch(/data-closed=""[^>]*data-request-id="5eed0000-0000-4000-8000-000000001009"/);
    expect(recent).toMatch(/data-closed=""[^>]*data-request-id="5eed0000-0000-4000-8000-000000001006"/);
    expect(recent).not.toMatch(/data-closed=""[^>]*data-request-id="5eed0000-0000-4000-8000-000000001010"/);
    expect(recent).toMatch(/1010<\/span> <span[^>]*>B\.W\.<\/span> <span[^>]*data-tone="blue"/);
    // A row with no name, and an hour-old update.
    expect(recent).toMatch(/1006<\/span> <span[^>]*data-empty=""[^>]*>No name<\/span>[\s\S]*?Reunited<\/span> <span[^>]*>1h</);
    // No recent rows: no section.
    const none = render(storeWith(), <DashboardContent stats={v7Stats({ recent: [] })} />);
    expect(none).not.toContain('Recently updated');
  });

  it('Performance: Longest wait (opens that request), Time to answer, Time to reunite, Logged', () => {
    const html = render(storeWith(), <DashboardContent stats={v7Stats()} />);
    const perf = html.slice(at(html, '>Performance<'));
    const order = ['perf-longest-wait', 'perf-answer', 'perf-reunite', 'perf-logged'].map((id) => at(perf, `data-testid="${id}"`));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(perf).toMatch(
      /<button[^>]*aria-label="Longest wait 1010 · FA 4 24m\. Request 1010 at FA 4 has been waiting 24 minutes\. Opens the request\."[^>]*data-testid="perf-longest-wait"/,
    );
    expect(slice(perf, 'perf-longest-wait', 2000)).toContain('>1010 · FA 4<');
    expect(perf).toMatch(/data-testid="perf-longest-wait-value"><span[^>]*>24<\/span><span[^>]*>m<\/span>/);
    expect(perf).toMatch(/data-testid="perf-answer-value"><span[^>]*>9<\/span><span[^>]*>m<\/span>/);
    expect(perf).toMatch(/data-testid="perf-reunite-value"><span[^>]*>18<\/span><span[^>]*>m<\/span>/);
    expect(perf).toMatch(/data-testid="perf-logged-value"><span[^>]*>6<\/span><\/span>/);
    // The windows (Brian 2026-11-06 21:55): both averages over the last 2 hours, Logged over the last hour.
    expect(perf).toMatch(/data-testid="perf-answer-context">last 2 hours</);
    expect(perf).toMatch(/data-testid="perf-reunite-context">last 2 hours</);
    expect(perf).toMatch(/data-testid="perf-logged-context">last hour</);
    expect(perf).not.toContain('avg');
    expect(perf).toContain('Average time to answer over the last 2 hours: 9 minutes.');
    expect(perf).toContain('Average time to reunite over the last 2 hours: 18 minutes.');
    expect(perf).toContain('Logged in the last hour: 6 requests.');
  });

  // Regression: a long Other location in the Longest wait context scrolled the page sideways on a phone
  // (layout covered in tests/e2e/dashboard.spec.ts). The context is its own span, the one that may shrink.
  it('Longest wait at a long Other location: the whole text in the context span and the label, the context ellipsizes', () => {
    const where = 'TEST-dash-1 Lost and found tent behind the stereoBloom stage';
    const longestWait = { id: '5eed0000-0000-4000-8000-000000001010', caseNumber: 1010, reportingLocation: 'Other', otherLocation: where, postShort: where, minutes: 24 };
    const html = render(storeWith(), <DashboardContent stats={v7Stats({ longestWait })} />);
    expect(html).toMatch(new RegExp(`<span class="([^"]+)" data-testid="perf-longest-wait-context">1010 · ${where}</span>`));
    expect(html).toContain(`aria-label="Longest wait 1010 · ${where} 24m. Request 1010 at ${where} has been waiting 24 minutes. Opens the request."`);
    expect(html).toMatch(/data-testid="perf-longest-wait-value"><span[^>]*>24<\/span><span[^>]*>m<\/span>/);
  });

  it('Performance row CSS: label and value never shrink; only the context does, with an ellipsis', () => {
    const css = readFileSync(fileURLToPath(new URL('../../../components/dashboard/dashboard.module.css', import.meta.url)), 'utf8');
    const rule = (sel: string) => {
      const m = css.match(new RegExp(`(?:^|\\n)\\${sel} \\{([^}]*)\\}`));
      expect(m, sel).not.toBeNull();
      return (m?.[1] ?? '').replace(/\s+/g, ' ');
    };
    const m = rule('.m');
    for (const decl of ['flex: 0 1 auto;', 'min-width: 0;', 'white-space: nowrap;', 'overflow: hidden;', 'text-overflow: ellipsis;']) expect(m).toContain(decl);
    expect(rule('.k')).toContain('flex: none;');
    expect(rule('.pv')).toContain('flex: none;');
    expect(rule('.kv')).toContain('min-width: 0;');
  });

  it('Performance: an empty value reads "None" with its sentence (Brian 2026-11-06 21:55)', () => {
    const stats = v7Stats({ longestWait: null, avgAnswerMinutes: null, avgReuniteMinutes: null });
    const html = render(storeWith(), <DashboardContent stats={stats} />);
    for (const id of ['perf-longest-wait', 'perf-answer', 'perf-reunite']) {
      expect(html).toMatch(new RegExp(`data-testid="${id}-value"><span[^>]*>None</span></span>`));
    }
    // Performance never shows "—" for a known-empty value (the F3 Friends en route tile's "—" is "not available").
    expect(html).not.toMatch(/perf-[a-z-]+-value"><span[^>]*>—</);
    // Nothing to open without a waiting request.
    expect(html).toMatch(/<div[^>]*data-testid="perf-longest-wait"/);
    expect(html).toContain('No one is waiting for a check.');
    expect(html).toContain('No answers in the last 2 hours.');
    expect(html).toContain('No reunions in the last 2 hours.');
    // Logged is a count: 0 is a value.
    expect(render(storeWith(), <DashboardContent stats={v7Stats({ loggedLastHour: 0 })} />)).toMatch(/data-testid="perf-logged-value"><span[^>]*>0<\/span><\/span>/);
    // A missing field (an older lp_stats) is empty too.
    const missing = v7Stats();
    delete (missing as Partial<Stats>).avgReuniteMinutes;
    delete (missing as Partial<Stats>).loggedLastHour;
    const old = render(storeWith(), <DashboardContent stats={missing} />);
    expect(old).toMatch(/data-testid="perf-reunite-value"><span[^>]*>None</);
    expect(old).toMatch(/data-testid="perf-logged-value"><span[^>]*>None</);
    expect(old).toContain('Nothing logged in the last hour.');
  });

  it('Performance keeps "—" only while the stats request fails: an empty value is not known to be empty', () => {
    const stats = v7Stats({ longestWait: null, avgAnswerMinutes: null, avgReuniteMinutes: null });
    delete (stats as Partial<Stats>).loggedLastHour;
    const html = render(storeWith(), <DashboardContent stats={stats} failed />);
    for (const id of ['perf-longest-wait', 'perf-answer', 'perf-reunite', 'perf-logged']) {
      expect(html).toMatch(new RegExp(`data-testid="${id}-value"><span[^>]*>—</span></span>`));
    }
    expect(html).not.toContain('>None<');
    expect(html).toContain('Longest wait: not available.');
    expect(html).toContain('Average time to answer over the last 2 hours: not available.');
    expect(html).toContain('Logged in the last hour: not available.');
    // Known values still show while it fails (the last good stats).
    expect(render(storeWith(), <DashboardContent stats={v7Stats()} failed />)).toMatch(/data-testid="perf-answer-value"><span[^>]*>9<\/span>/);
  });

  it('title: large "Dashboard" with Back, the line under it ("Updating…" until the first stats arrive), then the banner', () => {
    const live = render(storeWith(), <DashboardView />);
    expect(live).toMatch(/<h1[^>]*>Dashboard<\/h1>/);
    expect(live).toContain('aria-label="Back to requests"');
    // The line follows the title inside the header; before the first stats it reads "Updating…" with a turning arrow
    // in the dot's place and no Refresh now (network fix 1d; it showed nothing before). Under the header, the banner's
    // slot holds only the silent live region while healthy. The old Offline / Retrying chip is gone.
    expect(live).toMatch(
      /<\/h1><div class="[^"]*live[^"]*" data-state="healthy" data-updating="" data-testid="live-indicator"><svg[^>]*class="[^"]*liveSpin[^"]*"[^>]*>(?:<path[^>]*><\/path>)+<\/svg><span[^>]*data-testid="live-text">Updating…<\/span><span[^>]*>Updating the dashboard\.<\/span><\/div><\/header><div class="[^"]*banner[^"]*"><span[^>]*role="status"[^>]*data-testid="live-announcement"[^>]*><\/span><\/div><main/,
    );
    expect(live).not.toContain('Refresh now');
    expect(live).not.toContain('dashboard-connection');
    expect(live).not.toContain('Retrying');
    expect(live).not.toContain('>Live<');
    expect(live).not.toContain('Export CSV');
    // No stats yet: the skeleton.
    expect(live).toContain('aria-label="Loading dashboard"');
    // The list's sync failing: the same Reconnecting banner as the lists (the line waits for the first stats).
    for (const connection of ['offline', 'error'] as const) {
      const html = render(
        storeWith((s) => ({ ...s, connection })),
        <DashboardView />,
      );
      expect(html, connection).toMatch(/data-state="none" data-testid="live-indicator"/);
      expect(html, connection).toMatch(/<\/header><div class="[^"]*banner[^"]*"><div class="lp-banner[^"]*" data-tone="amber" data-testid="connection-banner"/);
      expect(html, connection).toContain('>Reconnecting…</span>');
    }
  });

  it('in the desk shell: no title row and no line (the top bar is the title and holds the line), the banner stays, six desk-sized tile placeholders', () => {
    const desk = render(
      storeWith((s) => ({ ...s, connection: 'offline' })),
      <DeskContext.Provider value>
        <DashboardView />
      </DeskContext.Provider>,
    );
    expect(desk).not.toContain('<h1');
    expect(desk).not.toContain('aria-label="Back to requests"');
    expect(desk).not.toContain('dashboard-connection');
    expect(desk).not.toContain('data-testid="live-indicator"');
    // The list's sync failing: the same Reconnecting banner at the top of the column, with its live region.
    expect(desk).toMatch(/^(<[^>]*>)*?<div class="[^"]*app[^"]*" data-testid="dashboard"><div class="[^"]*banner[^"]*"><div class="lp-banner[^"]*" data-tone="amber" data-testid="connection-banner"/);
    expect(desk).toContain('data-testid="live-announcement"');
    expect(desk).toContain('aria-label="Loading dashboard"');
    expect(desk.match(/height:92px/g) ?? []).toHaveLength(6);
  });

  it('renders the stub store’s own stats (the shape lp_stats returns)', async () => {
    const store = storeWith();
    const stats = await store.actions.fetchStats();
    const html = render(store, <DashboardContent stats={stats} />);
    expect(html).toMatch(new RegExp(`data-testid="open-count"[^>]*>${stats.open.waiting + stats.open.inMedical}<`));
    expect(html).toContain('Recently updated');
  });
});
