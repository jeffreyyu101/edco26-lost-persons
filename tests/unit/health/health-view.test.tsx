// The Health page (components/health, react-dom/server): values before labels, every chip and bar has a glyph and a
// full-sentence label, no visible text over 6 words (Brian's rule; screen-reader-only text aside), a section the
// server could not read shows "—", and a phone width gets "Desktop only".
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DesktopOnly, HealthDashboard } from '@/components/health/HealthView';
import { fmtMs, grade, pct, problemSentence, summarizePaths, trend, type HealthData } from '@/components/health/health-model';

const AT = '2026-11-09T03:00:00.000Z';
const fixture = (): HealthData => ({
  generatedAt: AT,
  window: '3h',
  config: { on: true, enabled: true, until: Date.parse('2026-11-10T11:00:00Z'), flushSeconds: 60, sample: 1 },
  kpis: { devices: 38, sessions: 51, events: 9_000, frustrations: 412, hitDevices: 17, errors: 9, syncOk: 986, syncFail: 14, pushRx: 100, pushOpened: 71, openP95: 3_100, prev: { devices: 30, frustrations: 300, hitDevices: 20, errors: 9 } },
  problems: [
    { name: 'stuck_scroll', view: 'profile', area: 'thread', ctl: null, n: 41, devices: 12, teams: ['medical', 'dispatch'], lastAt: '2026-11-09T02:58:00.000Z', examples: [7, 8] },
    { name: 'rage_tap', view: 'pending', area: 'pending-column-#', ctl: 'check-card', n: 17, devices: 9, teams: ['medical'], lastAt: '2026-11-09T02:40:00.000Z', examples: [9] },
  ],
  examples: [{ id: 7, name: 'stuck_scroll', at: AT, team: 'medical', view: 'profile', area: 'thread', ctl: null, ms: null, k: 3, props: { dir: 'up' }, trail: [[-12_400, 'v>profile'], [-800, 'w!:thread:u']] }],
  flows: [
    { name: 'flow_open', out: 'ok', n: 212, p50: 1_200, p95: 3_100 },
    { name: 'flow_answer', out: 'ok', n: 188, p50: 400, p95: 2_900 },
    { name: 'flow_new', out: 'submit', n: 25, p50: 48_000, p95: 156_000 },
    { name: 'flow_new', out: 'abandon', n: 6, p50: 9_000, p95: 30_000 },
  ],
  net: { rows: [{ pattern: '/api/sync:delta', m: 'get', n: 9_812, failed: 39, timeouts: 3, c4xx: 2, p50: 210, p95: 900, states: { live: { n: 9_700, failed: 10 }, offline: { n: 100, failed: 29 } } }], sync: { ok: 986, fail: 14, full: 4, ageP95: 12 } },
  push: [{ kind: 'new_request', ok: 120, gone: 2, failed: 1, rx: 96, shown: 90, opened: 41, t50: 800, t95: 2_200 }],
  coverage: [{ team: 'medical', devices: 14, standalone: 12, granted: 11, pushsub: 12, newreq: 13, subs: 15, subsNewreq: 14, alerts: 30, within30: 28, p50: 4_000 }],
  errors: [{ fp: 'abcd1234', type: 'typeerror', src: 'chunk:3fa2c1d0', line: '1', col: '48211', n: 3, devices: 2, teams: ['medical'], views: ['profile'], lastAt: AT }],
});

/** Visible text: the markup without screen-reader-only spans and without attributes, split on tags. */
function visibleTexts(html: string): string[] {
  const withoutSr = html.replace(/<span class="[^"]*\bsr\b[^"]*">[^<]*<\/span>/g, '');
  return withoutSr
    .split(/<[^>]+>/)
    .map((t) => t.replace(/&[a-z#0-9]+;/g, ' ').trim())
    .filter(Boolean);
}

describe('HealthDashboard', () => {
  it('renders every panel, values first', () => {
    const html = renderToStaticMarkup(<HealthDashboard data={fixture()} onTrail={() => undefined} />);
    for (const id of ['panel-problems', 'panel-paths', 'panel-net', 'panel-push', 'panel-coverage', 'panel-errors', 'health-kpis']) expect(html, id).toContain(`data-testid="${id}"`);
    const kpi = html.slice(html.indexOf('data-testid="kpi-frustrations"'));
    expect(kpi.indexOf('412')).toBeLessThan(kpi.indexOf('frustrations<'));
    expect(html).toContain('/api/sync:delta');
    expect(html).toContain('profile › thread');
  });

  it('every chip and bar is an image with a full-sentence label; glyphs carry the state', () => {
    const html = renderToStaticMarkup(<HealthDashboard data={fixture()} onTrail={() => undefined} />);
    const labels = [...html.matchAll(/role="img" aria-label="([^"]+)"/g)].map((m) => m[1] as string);
    expect(labels.length).toBeGreaterThan(10);
    expect(labels).toContain('Stuck scroll in thread on the request page: 41 times on 12 devices, Medical and Dispatch, last 2 minutes ago.');
    for (const l of labels) expect(l.split(/\s+/).length, l).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<svg');
    expect(html).toMatch(/✓|↑/);
  });

  it('no visible text over 6 words', () => {
    const html = renderToStaticMarkup(<HealthDashboard data={fixture()} onTrail={() => undefined} />);
    for (const t of visibleTexts(html)) expect(t.split(/\s+/).length, t).toBeLessThanOrEqual(6);
  });

  it('a section the server could not read shows "—"; the others still render', () => {
    const data = { ...fixture(), problems: null, net: null, kpis: null };
    const html = renderToStaticMarkup(<HealthDashboard data={data} onTrail={() => undefined} />);
    expect(html).toContain('aria-label="Could not be read"');
    expect(html).toContain('—');
    expect(html).toContain('data-testid="health-paths"');
  });

  it('a phone width: Desktop only', () => {
    const html = renderToStaticMarkup(<DesktopOnly />);
    expect(html).toContain('Desktop only');
    expect(html).toContain('<svg');
  });
});

describe('the model', () => {
  it('formats, grades and trends', () => {
    expect(fmtMs(420)).toBe('420 ms');
    expect(fmtMs(1_200)).toBe('1.2 s');
    expect(fmtMs(156_000)).toBe('2.6 m');
    expect(fmtMs(null)).toBe('—');
    expect(pct(986, 1_000)).toBe('98.6 %');
    expect(pct(1, 0)).toBe('—');
    expect(grade(2_000, 3_000)).toBe('ok');
    expect(grade(5_000, 3_000)).toBe('warn');
    expect(grade(7_000, 3_000)).toBe('bad');
    expect(trend(412, 300)?.glyph).toBe('↑');
    expect(trend(412, 300)?.color).toBe('red');
    expect(trend(38, 30, false)?.color).toBe('green');
  });

  it('paths: n over every outcome, percentiles from the good one', () => {
    const p = summarizePaths(fixture().flows ?? []).find((x) => x.def.name === 'flow_new');
    expect(p).toEqual(expect.objectContaining({ n: 31, p50: 48_000, p95: 156_000 }));
    expect(p?.outs).toEqual([
      { out: 'submit', n: 25 },
      { out: 'abandon', n: 6 },
    ]);
  });

  it('the problem sentence names the place, counts, teams and when', () => {
    expect(problemSentence(fixture().problems![1]!, Date.parse(AT))).toBe('Rage tap in pending-column-# on Pending at check-card: 17 times on 9 devices, Medical, last 20 minutes ago.');
  });
});
