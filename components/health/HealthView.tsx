'use client';
// The Health page (/health, desktop only; design/references/observability-design.md §5): what staff ran into on the
// floor, from the in-house telemetry. Data loads on mount and on Refresh only (no polling). Values first and large,
// labels small; glyphs and colour carry state; screen readers hear full sentences. The switch turns collection off
// (behind a confirm) through POST /api/telemetry/settings, and back on with one tap. (Events) Leads only: for staff the
// switch shows the state and is disabled.
// Plain elements on Radix Themes' CSS variables, inline glyphs, no lib/telemetry: this chunk shares no module with
// `/`'s first load, which the bundler otherwise regroups (+320 B gzipped, over A25's 42 KB).
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { HealthWindow } from '@/lib/telemetry';
import { Monitor, RefreshCw } from './icons';
import { useModal } from './TrailDrawer';
import { CoverageTable } from './CoverageTable';
import { ErrorList } from './ErrorList';
import { NetTable } from './NetTable';
import { PathTable } from './PathTable';
import { ProblemTable } from './ProblemTable';
import { PushPanel } from './PushPanel';
import { TrailDrawer } from './TrailDrawer';
import { DASH, HEALTH_SEEN_KEY, WINDOWS, fmtClock, fmtMs, num, pct, trend, applyHealthEvent, type HealthData, type Problem } from './health-model';
import s from './health.module.css';

const DESK_QUERY = '(min-width: 768px)';
const WINDOW_LABEL: Readonly<Record<HealthWindow, string>> = { '1h': '1 h', '3h': '3 h', '12h': '12 h', all: 'All' };

function subscribeDesk(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const mql = window.matchMedia(DESK_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}
const deskNow = () => typeof window === 'undefined' || !window.matchMedia || window.matchMedia(DESK_QUERY).matches;
const deskServer = () => true;

export function DesktopOnly() {
  return (
    <main className={s.desktopOnly} data-testid="health-desktop-only">
      <span className={s.bigIcon} aria-hidden>
        <Monitor size={24} strokeWidth={1.75} />
      </span>
      <h1 className={s.h3}>Desktop only</h1>
    </main>
  );
}

function Kpi({ value, label, extra, testid }: { value: ReactNode; label: string; extra?: ReactNode; testid?: string }) {
  return (
    <div className={s.kpi} data-testid={testid}>
      <span className={s.kpiValue}>
        <span className={s.big}>{value}</span>
        {extra}
      </span>
      <span className={s.kpiLabel}>{label}</span>
    </div>
  );
}

function Trend({ now, before, upIsBad = true }: { now: number | undefined; before: number | undefined; upIsBad?: boolean }) {
  const t = trend(now, before, upIsBad);
  if (!t) return null;
  return (
    <span className={s.glyph} data-color={t.color} role="img" aria-label={t.words}>
      {t.glyph}
    </span>
  );
}

function Panel({ title, children, wide, testid }: { title: string; children: ReactNode; wide?: boolean; testid?: string }) {
  return (
    <section className={`${s.card} ${wide ? s.wide : ''}`} data-testid={testid} aria-label={title}>
      <div className={s.panelHead}>
        <h2 className={s.h2}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

/** The dashboard for one answer of GET /api/telemetry/health (pure: the tests render it with fixtures). */
export function HealthDashboard({ data, onTrail }: { data: HealthData; onTrail: (p: Problem) => void }) {
  applyHealthEvent(data);
  const now = Date.parse(data.generatedAt) || 0;
  const k = data.kpis;
  const syncTotal = (k?.syncOk ?? 0) + (k?.syncFail ?? 0);
  return (
    <>
      <section className={s.kpis} aria-label="Key numbers" data-testid="health-kpis">
        <Kpi testid="kpi-devices" value={k ? num(k.devices) : DASH} label="devices" extra={<Trend now={k?.devices} before={k?.prev?.devices} upIsBad={false} />} />
        <Kpi testid="kpi-frustrations" value={k ? num(k.frustrations) : DASH} label="frustrations" extra={<Trend now={k?.frustrations} before={k?.prev?.frustrations} />} />
        <Kpi testid="kpi-hit" value={k ? num(k.hitDevices) : DASH} label="devices hit" extra={<Trend now={k?.hitDevices} before={k?.prev?.hitDevices} />} />
        <Kpi testid="kpi-errors" value={k ? num(k.errors) : DASH} label="errors" extra={<Trend now={k?.errors} before={k?.prev?.errors} />} />
        <Kpi testid="kpi-syncs" value={k ? pct(k.syncOk, syncTotal) : DASH} label="syncs ok" />
        <Kpi testid="kpi-opened" value={k ? pct(k.pushOpened, k.pushRx) : DASH} label="pushes opened" />
        <Kpi testid="kpi-open" value={k ? fmtMs(k.openP95) : DASH} label="open → fresh p95" />
      </section>
      <div className={s.grid}>
        <Panel title="Problem spots" testid="panel-problems">
          <ProblemTable rows={data.problems} now={now} onTrail={onTrail} />
        </Panel>
        <Panel title="Critical paths" testid="panel-paths">
          <PathTable rows={data.flows} />
        </Panel>
        <Panel title="Requests" testid="panel-net">
          <NetTable net={data.net} />
        </Panel>
        <Panel title="Push" testid="panel-push">
          <PushPanel rows={data.push} />
        </Panel>
        <Panel title="Alert coverage" wide testid="panel-coverage">
          <CoverageTable rows={data.coverage} />
        </Panel>
        <Panel title="Errors" wide testid="panel-errors">
          <ErrorList rows={data.errors} />
        </Panel>
      </div>
    </>
  );
}

type LoadResult = { kind: 'ok'; data: HealthData } | { kind: 'auth' } | { kind: 'fail' };

/** GET /api/telemetry/health for one window. Never rejects. */
async function loadHealth(w: HealthWindow, event: string): Promise<LoadResult> {
  try {
    const res = await fetch(`/api/telemetry/health?window=${w}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      // (Events) An event route refuses a call that does not say which event it is for (409 wrong_event).
      headers: { Accept: 'application/json', 'X-LP-Event': event },
    });
    if (res.status === 401) return { kind: 'auth' };
    if (!res.ok) return { kind: 'fail' };
    return { kind: 'ok', data: (await res.json()) as HealthData };
  } catch {
    return { kind: 'fail' };
  }
}

export function HealthView({ lead, event }: { lead: boolean; event: string }) {
  const desk = useSyncExternalStore(subscribeDesk, deskNow, deskServer);
  const [win, setWin] = useState<HealthWindow>('3h');
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [trail, setTrail] = useState<Problem | null>(null);
  const closeTrail = useCallback(() => setTrail(null), []);
  const closeConfirm = useCallback(() => setConfirmOff(false), []);

  const apply = useCallback((result: LoadResult) => {
    if (result.kind === 'auth') {
      window.location.replace('/signin?next=/health');
      return;
    }
    if (result.kind === 'ok') setData(result.data);
    setFailed(result.kind === 'fail');
    setLoading(false);
  }, []);

  const refresh = (w: HealthWindow = win) => {
    if (loading) return;
    setLoading(true);
    void loadHealth(w, event).then(apply);
  };

  useEffect(() => {
    try {
      window.localStorage.setItem(HEALTH_SEEN_KEY, '1');
    } catch {
      // the sidebar link is a convenience
    }
    let live = true;
    void loadHealth('3h', event).then((r) => {
      if (live) apply(r);
    });
    return () => {
      live = false;
    };
  }, [apply, event]);

  const setEnabled = async (enabled: boolean) => {
    setSwitching(true);
    try {
      const res = await fetch('/api/telemetry/settings', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        const config = (await res.json()) as HealthData['config'];
        setData((d) => (d ? { ...d, config } : d));
      }
    } finally {
      setSwitching(false);
    }
  };

  if (!desk) return <DesktopOnly />;
  const cfg = data?.config ?? null;
  const on = !!cfg?.on;
  return (
    <main className={s.page} data-testid="health">
      <header className={s.head}>
        <h1 className={`${s.h1} ${s.title}`}>Health</h1>
        <div className={s.seg} role="group" aria-label="Window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={s.segItem}
              aria-pressed={w === win}
              onClick={() => {
                if (w === win) return;
                setWin(w);
                refresh(w);
              }}
            >
              {WINDOW_LABEL[w]}
            </button>
          ))}
        </div>
        <span className={s.row}>
          <button type="button" className={s.iconBtn} aria-label="Refresh" onClick={() => refresh()} disabled={loading} data-testid="health-refresh">
            <RefreshCw size={16} />
          </button>
          <span className={s.when} role="img" aria-label={data ? `Updated ${fmtClock(data.generatedAt)}` : 'Not loaded yet'}>
            {data ? fmtClock(data.generatedAt) : DASH}
          </span>
          {failed ? (
            <span className={s.chip} data-color="red" role="img" aria-label="The last refresh failed">
              ✕
            </span>
          ) : null}
        </span>
        {/* (Events) Collection runs while an event is in practice or live: no off date any more. */}
        <span className={s.status} data-testid="health-status" role="img" aria-label={on ? 'Collecting while an event is in practice or live' : 'Collection is off'}>
          <span className={s.dot} data-off={on ? undefined : ''} />
          {on ? 'Collecting' : 'Off'}
        </span>
        <button
          type="button"
          role="switch"
          className={s.switch}
          aria-checked={!!cfg?.enabled}
          aria-label={lead ? 'Collection' : 'Collection. Only a lead can switch it'}
          disabled={!lead || !cfg || switching}
          data-testid="health-switch"
          onClick={() => {
            if (cfg?.enabled) setConfirmOff(true);
            else void setEnabled(true).then(() => refresh());
          }}
        >
          <span className={s.thumb} />
        </button>
      </header>
      {data ? <HealthDashboard data={data} onTrail={setTrail} /> : <p className={s.empty}>{loading ? '' : DASH}</p>}
      <TrailDrawer problem={trail} examples={data?.examples ?? []} onClose={closeTrail} />
      <ConfirmOff open={confirmOff} onClose={closeConfirm} onConfirm={() => void setEnabled(false).then(() => refresh())} />
    </main>
  );
}

/** "Turn off collection?" with Cancel (the safe choice, focused first) and Turn off. */
function ConfirmOff({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: () => void }) {
  const ref = useModal(open, onClose);
  return (
    <dialog ref={ref} className={s.alert} role="alertdialog" aria-labelledby="health-off-title" data-testid="health-confirm">
      {open ? (
        <>
          <h2 id="health-off-title" className={s.h2}>
            Turn off collection?
          </h2>
          <div className={s.actions}>
            <button type="button" className={s.btn} data-variant="soft" autoFocus onClick={() => ref.current?.close()}>
              Cancel
            </button>
            <button
              type="button"
              className={s.btn}
              data-variant="danger"
              data-testid="health-turn-off"
              onClick={() => {
                ref.current?.close();
                onConfirm();
              }}
            >
              Turn off
            </button>
          </div>
        </>
      ) : null}
    </dialog>
  );
}
