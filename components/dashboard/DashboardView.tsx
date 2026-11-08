'use client';
// Dashboard v4 (?dashboard=1, design/screens/dashboard-v4.html; approved 2026-11-08). GET /api/stats?range=… every
// 15 s while open and visible (use-dashboard-stats.ts).
//   status     Open N · one segmented bar (Waiting / Pending / Located) with its boundary values · glyph legend.
//              A segment or legend entry opens the list it counts.
//   attention  The 5 most urgent open requests (waiting age, overdue re-checks, Located awaiting the friend with the
//              walk ETA), timers ticking each second, colour always with a glyph. A row opens the request.
//   speed      Medians from logged to First check / Located / Reunited against 10 / 15 / 30 min; details (p90, per
//              tent, sparkline) in a hover card.
//   calls      Calls per 15 min (Total / By tent / Heatmap, or a table), the night before as a dashed line, then
//              the recap (reunited, not located, fastest, last reunion).
// Desk (≥ 768 px): status across, Needs attention + Speed beside Calls; who's on and the range sit in the shell's
// top bar (portalled into its slot). Phone: ‹ Dashboard with who's on, the range under it, one column.
import { DataList, HoverCard, SegmentedControl, Skeleton, VisuallyHidden } from '@radix-ui/themes';
import { ArrowUp, Check, ChevronLeft, ChevronRight, Clock, History, Table2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { WalkIcon } from '@/components/messages/WalkIcon';
import { useInDesk } from '@/components/desk/desk-context';
import { ConnectionBanner } from '@/components/ui/Banner';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusGlyph, SwapGlyph } from '@/components/ui/StatusGlyph';
import type { SpeedStat, Stats, StatsRange } from '@/lib/api-types';
import { goBack, navigate } from '@/lib/client/nav';
import { useLiveStatus } from '@/lib/client/use-live-status';
import { STATUS } from '@/lib/domain';
import { DEFAULT_STATS_RANGE, STATS_RANGES, STATS_RANGE_LABEL, isStatsRange } from '@/lib/stats-range';
import { CallsChart, HeatChart, Spark, TENT_VAR } from './charts';
import {
  NO_VALUE,
  SPEED_LABEL,
  TEAM_LABEL,
  TENTS,
  TENT_KEY,
  attentionPhrase,
  attentionRows,
  boundaries,
  bucketTotal,
  delta,
  fmtM,
  heatLabel,
  mmss,
  prevNightName,
  speedBadge,
  statusParts,
  teamTotal,
  timerText,
  type Sev,
  type StatusPart,
} from './dashboard-model';
import { useDashboardSlot } from './connection-signal';
import { useDashboardStats } from './use-dashboard-stats';
import s from './dashboard.module.css';

export type DashboardViewProps = Record<string, never>;
type CallsView = 'total' | 'tent' | 'heat';

const RANGE_KEY = 'lp-dash-range';
const VIEW_KEY = 'lp-dash-view';
function remembered<T extends string>(key: string, ok: (v: unknown) => v is T, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    // Private mode: the choice lasts this visit only.
  }
}
const isView = (v: unknown): v is CallsView => v === 'total' || v === 'tent' || v === 'heat';

export function DashboardView(_props: DashboardViewProps) {
  // "Try again" remounts the poller, which fetches at once.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  return <Dashboard key={attempt} onRetry={() => setAttempt((n) => n + 1)} />;
}

function Dashboard({ onRetry }: { onRetry: () => void }) {
  const [range, setRangeState] = useState<StatsRange>(() => remembered(RANGE_KEY, isStatsRange, DEFAULT_STATS_RANGE));
  const [view, setViewState] = useState<CallsView>(() => remembered(VIEW_KEY, isView, 'total'));
  const setRange = (r: StatsRange) => {
    setRangeState(r);
    remember(RANGE_KEY, r);
  };
  const setView = (v: CallsView) => {
    setViewState(v);
    remember(VIEW_KEY, v);
  };
  const { stats, error, failing, updatedAt, skew } = useDashboardStats(range);
  const inDesk = useInDesk();
  const slot = useDashboardSlot();
  const live = useLiveStatus({ syncedAt: updatedAt, failing, subject: 'Dashboard' });
  const who = <Who team={stats?.team} />;
  const rangeCtl = <RangeControl value={range} onChange={setRange} />;

  return (
    <div className={s.app} data-testid="dashboard" data-desk={inDesk ? '' : undefined}>
      {inDesk ? (
        slot ? createPortal(<><span className={s.vsep} aria-hidden />{who}<span className={s.sp} />{rangeCtl}</>, slot) : null
      ) : (
        <>
          <header className={s.nav}>
            <button type="button" className={s.back} aria-label="Back to requests" onClick={() => goBack({})}>
              <ChevronLeft size={24} strokeWidth={2} aria-hidden />
            </button>
            <h1 className={s.title}>Dashboard</h1>
            <span className={s.sp} />
            {who}
          </header>
          <div className={s.pctl}>{rangeCtl}</div>
        </>
      )}
      <div className={s.banner}>
        <ConnectionBanner status={live} />
      </div>
      {stats ? (
        <DashboardContent stats={stats} range={range} view={view} onView={setView} phone={!inDesk} skew={skew} />
      ) : error ? (
        <EmptyState icon="plug" title="Can't reach the log" action={{ label: 'Try again', onClick: onRetry, icon: 'refresh' }} />
      ) : (
        <Loading phone={!inDesk} />
      )}
    </div>
  );
}

function RangeControl({ value, onChange }: { value: StatsRange; onChange: (r: StatsRange) => void }) {
  return (
    <SegmentedControl.Root
      size="1"
      radius="full"
      className={s.seg}
      value={value}
      onValueChange={(v) => isStatsRange(v) && onChange(v)}
      aria-label="Time range"
      data-testid="range"
    >
      {STATS_RANGES.map((k) => (
        <SegmentedControl.Item key={k} value={k}>
          {STATS_RANGE_LABEL[k]}
        </SegmentedControl.Item>
      ))}
    </SegmentedControl.Root>
  );
}

/** A hover card that also opens on tap and focus (the phone has no hover). */
function Pop({ trigger, children, label }: { trigger: (open: boolean) => ReactNode; children: ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <HoverCard.Root open={open} onOpenChange={setOpen} openDelay={80} closeDelay={120}>
      <HoverCard.Trigger onClick={() => setOpen((o) => !o)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        {trigger(open)}
      </HoverCard.Trigger>
      <HoverCard.Content size="1" className={s.pop} aria-label={label} side="bottom" align="start">
        {children}
      </HoverCard.Content>
    </HoverCard.Root>
  );
}

const TEAM_ORDER = ['medical', 'dispatch', 'base', 'transpo', 'other'];
function Who({ team }: { team: Stats['team'] }) {
  const rows = [...(team ?? [])].sort((a, b) => TEAM_ORDER.indexOf(a.team) - TEAM_ORDER.indexOf(b.team));
  const n = teamTotal(rows);
  const sr = rows.map((t) => `${TEAM_LABEL[t.team] ?? t.team} ${t.on || 'none'}`).join(', ');
  if (!team) return null;
  return (
    <Pop
      label="Who's on"
      trigger={(open) => (
        <button type="button" className={s.who} aria-expanded={open} data-testid="who">
          <i className={s.ld} aria-hidden />
          <b aria-hidden>{n}</b>
          <span aria-hidden>on</span>
          <VisuallyHidden>{`${n} people on in the last 10 minutes: ${sr}`}</VisuallyHidden>
          <span className={s.dots} aria-hidden>
            {rows.map((t) => (
              <i key={t.team} className={t.on ? s.tdot : `${s.tdot} ${s.off}`} />
            ))}
          </span>
        </button>
      )}
    >
      <div className={s.tl}>
        {rows.map((t) => (
          <span key={t.team} className={s.tlr}>
            <i className={t.on ? s.tdot : `${s.tdot} ${s.off}`} />
            <b className={t.on ? undefined : s.offv}>{t.on || '–'}</b>
            <span>{TEAM_LABEL[t.team] ?? t.team}</span>
          </span>
        ))}
      </div>
    </Pop>
  );
}

/** The server's clock, ticking each second (the timers). */
function useServerNow(skew: number, everyMs = 1000): number {
  const [device, setDevice] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setDevice(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return device + skew;
}

export interface DashboardContentProps {
  stats: Stats;
  range: StatsRange;
  view?: CallsView;
  onView?: (v: CallsView) => void;
  phone?: boolean;
  skew?: number;
}

/** Everything under the controls, for a loaded Stats (exported for the server-render unit tests). */
export function DashboardContent({ stats, range, view = 'total', onView = () => {}, phone = false, skew = 0 }: DashboardContentProps) {
  return (
    <main className={phone ? `${s.dash} ${s.phone}` : `${s.dash} ${s.desk}`} data-range={stats.range?.key ?? range}>
      <StatusCard stats={stats} />
      <Attention stats={stats} skew={skew} />
      <Speed stats={stats} range={range} skew={skew} />
      <Calls stats={stats} range={range} view={view} onView={onView} phone={phone} skew={skew} />
    </main>
  );
}

// ---- status -------------------------------------------------------------------------------------------------

const PART_COLOR: Readonly<Record<StatusPart['k'], string>> = { waiting: 'var(--blue-9)', pending: 'var(--violet-9)', located: 'var(--green-9)' };
const PART_SR: Readonly<Record<StatusPart['k'], string>> = { waiting: 'waiting for a first check', pending: 'pending a re-check', located: 'located, friend not here yet' };
const PART_GO: Readonly<Record<StatusPart['k'], Parameters<typeof navigate>[0]>> = {
  waiting: { status: STATUS.waiting },
  pending: { view: 'pending' },
  located: { status: STATUS.inMedical },
};

function PartGlyph({ k, size = 14 }: { k: StatusPart['k'] | 'recheck'; size?: number }) {
  if (k === 'pending' || k === 'recheck') return <History size={size} strokeWidth={2.25} color="var(--violet-11)" aria-hidden className={s.sg} />;
  return <StatusGlyph kind={k === 'waiting' ? 'waiting' : 'inMedical'} size={size} className={s.sg} />;
}

function StatusCard({ stats }: { stats: Stats }) {
  const parts = statusParts(stats);
  const open = parts.reduce((a, p) => a + p.n, 0);
  const cuts = boundaries(parts);
  return (
    <section className={`${s.card} ${s.status} ${s.zStatus}`} aria-label={`Open ${open}: ${parts.map((p) => `${p.n} ${PART_SR[p.k]}`).join(', ')}`} data-testid="status">
      <button type="button" className={s.open} onClick={() => navigate({ view: 'pending' })}>
        <span aria-hidden>Open</span>
        <b data-testid="open-count" aria-hidden>
          {open}
        </b>
        <VisuallyHidden>{`Open ${open}. Show open requests`}</VisuallyHidden>
      </button>
      <div className={s.cbar} aria-hidden>
        <div className={s.cbl}>
          {cuts.map((v, i) => (
            <span key={i} style={{ left: `${open ? (v / open) * 100 : 0}%` }}>
              {v}
            </span>
          ))}
        </div>
        <div className={s.sbar}>
          {parts
            .filter((p) => p.n > 0)
            .map((p) => (
              <i key={p.k} data-part={p.k} style={{ flex: p.n, background: PART_COLOR[p.k] }} onClick={() => navigate(PART_GO[p.k])} />
            ))}
        </div>
      </div>
      <div className={s.slg}>
        {parts.map((p) => (
          <button key={p.k} type="button" onClick={() => navigate(PART_GO[p.k])} data-testid={`status-${p.k}`}>
            <PartGlyph k={p.k} />
            <span aria-hidden>{p.name}</span>
            <b aria-hidden>{p.n}</b>
            <VisuallyHidden>{`${p.n} ${PART_SR[p.k]}. Show them`}</VisuallyHidden>
          </button>
        ))}
      </div>
    </section>
  );
}

// ---- needs attention --------------------------------------------------------------------------------------------

function SevGlyph({ sev, size = 14 }: { sev: Sev; size?: number }) {
  if (sev === 'warn') return <Clock size={size} strokeWidth={2.4} color="var(--amber-11)" aria-hidden className={s.sg} />;
  if (sev === 'crit')
    return (
      <svg className={s.sg} width={size} height={size} viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r="6.5" fill="var(--red-9)" />
        <path d="M7 3.6v4.1" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="7" cy="10.1" r="1" fill="#fff" />
      </svg>
    );
  return (
    <svg className={s.sg} width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--gray-11)" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="2" fill="var(--gray-11)" />
    </svg>
  );
}

function Attention({ stats, skew }: { stats: Stats; skew: number }) {
  const now = useServerNow(skew);
  const att = stats.attention;
  const rows = attentionRows(att?.items ?? [], now).slice(0, 5);
  const more = Math.max(0, (att?.total ?? 0) - rows.length);
  return (
    <section className={`${s.card} ${s.zAtt}`} aria-label="Needs attention" data-testid="attention">
      <div className={s.zh}>
        <h2 className={s.zt}>Needs attention</h2>
      </div>
      {rows.length ? (
        <ul className={s.att}>
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" className={s.ar} onClick={() => navigate({ r: r.id })} data-testid="attention-row" data-kind={r.kind} data-sev={r.sev}>
                <VisuallyHidden>{attentionPhrase(r)}</VisuallyHidden>
                {r.kind === 'swap' ? <SwapGlyph tone="blue" size={15} /> : <PartGlyph k={r.kind === 'wait' ? 'waiting' : r.kind === 'recheck' ? 'recheck' : 'located'} size={16} />}
                <span className={s.case} aria-hidden>
                  {r.caseNumber}
                </span>
                <span className={s.tchip} aria-hidden>
                  {r.tent}
                </span>
                <span />
                {r.enroute ? (
                  <span className={s.eta} aria-hidden>
                    <WalkIcon size={15} />
                    {r.eta === null ? null : r.eta < 1 ? '<1m' : `${r.eta}m`}
                  </span>
                ) : (
                  <span />
                )}
                <span className={s.tmr} data-sev={r.sev} aria-hidden>
                  <SevGlyph sev={r.sev} />
                  {timerText(r)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className={s.clear} data-testid="attention-clear">
          <SevGlyph sev="ok" />
          <VisuallyHidden>Nothing needs attention</VisuallyHidden>
        </div>
      )}
      {more > 0 ? (
        <button type="button" className={s.more} onClick={() => navigate({ view: 'pending' })} aria-label={`Show ${more} more open requests`} data-testid="attention-more">
          +{more} more
          <ChevronRight size={14} aria-hidden />
        </button>
      ) : null}
    </section>
  );
}

// ---- speed --------------------------------------------------------------------------------------------------------

function Speed({ stats, range, skew }: { stats: Stats; range: StatsRange; skew: number }) {
  const speed = stats.speed ?? [];
  return (
    <section className={`${s.card} ${s.zSpd}`} aria-label="Speed: median minutes from logged to each step" data-testid="speed">
      <div className={s.zh}>
        <h2 className={s.zt}>Speed</h2>
      </div>
      <div className={s.spd}>
        {(['firstCheck', 'located', 'reunited'] as const).map((k) => {
          const st = speed.find((x) => x.key === k);
          return <SpeedCol key={k} k={k} stat={st} range={range} skew={skew} />;
        })}
      </div>
    </section>
  );
}

function SpeedCol({ k, stat, range, skew }: { k: SpeedStat['key']; stat: SpeedStat | undefined; range: StatsRange; skew: number }) {
  const label = SPEED_LABEL[k];
  const badge = stat ? speedBadge(stat) : null;
  const sr = !stat || stat.median === null ? `${label}: no data in range` : `${label}: median ${fmtM(stat.median)} minutes, ${badge?.sev === 'ok' ? 'under' : 'over'} the ${stat.target} minute target. Details`;
  const col = (open: boolean) => (
    <button type="button" className={s.sp3} aria-expanded={open} data-testid={`speed-${k}`}>
      <VisuallyHidden>{sr}</VisuallyHidden>
      <span className={s.l} aria-hidden>
        {label}
      </span>
      {badge ? (
        <span className={s.tb} data-sev={badge.sev} aria-hidden>
          {badge.sev === 'ok' ? <Check size={12} strokeWidth={2.5} /> : <ArrowUp size={12} strokeWidth={2.5} />}
          <span className={s.d}>{badge.delta}</span>
        </span>
      ) : null}
      <span className={s.v} aria-hidden>
        <span className={s.n}>
          {fmtM(stat?.median)}
          {typeof stat?.median === 'number' ? <small>m</small> : null}
        </span>
      </span>
    </button>
  );
  if (!stat) return col(false);
  return (
    <Pop label={`${label} details`} trigger={col}>
      <SpeedDetails stat={stat} label={label} range={range} skew={skew} />
    </Pop>
  );
}

function SpeedDetails({ stat, label, range, skew }: { stat: SpeedStat; label: string; range: StatsRange; skew: number }) {
  const now = useServerNow(skew, 60_000);
  return (
    <>
      <div className={s.ph}>
        <div>{label}</div>
        <span>{STATS_RANGE_LABEL[range]}</span>
      </div>
      <DataList.Root size="1" className={s.dl}>
        <DataList.Item>
          <DataList.Label minWidth="0">p90</DataList.Label>
          <DataList.Value>{stat.p90 === null ? NO_VALUE : `${Math.round(stat.p90)}m`}</DataList.Value>
        </DataList.Item>
        <DataList.Item>
          <DataList.Label minWidth="0">Target</DataList.Label>
          <DataList.Value>{stat.target}m</DataList.Value>
        </DataList.Item>
        {(['FA 4', 'FA 3'] as const).map((t) => (
          <DataList.Item key={t}>
            <DataList.Label minWidth="0">
              <i className={s.tw} style={{ background: TENT_VAR[t] }} />
              {t}
            </DataList.Label>
            <DataList.Value>{`${fmtM(stat.byTent[t])}m`}</DataList.Value>
          </DataList.Item>
        ))}
      </DataList.Root>
      <div className={s.spk}>
        <Spark stat={stat} now={now} />
      </div>
    </>
  );
}

// ---- calls + recap ------------------------------------------------------------------------------------------------

const VIEWS: ReadonlyArray<[CallsView, string]> = [
  ['total', 'Total'],
  ['tent', 'By tent'],
  ['heat', 'Heatmap'],
];

function Calls({ stats, range, view, onView, phone, skew }: { stats: Stats; range: StatsRange; view: CallsView; onView: (v: CallsView) => void; phone: boolean; skew: number }) {
  const [table, setTable] = useState(false);
  const now = useServerNow(skew, 15_000);
  const calls = stats.calls ?? { total: stats.loggedLastHour, prevTotal: null, buckets: [] };
  const heat = stats.heat ?? { step: 60, cols: [] };
  const step = stats.range?.step ?? 15;
  const compare = !!stats.range?.compare;
  const prevName = stats.range ? prevNightName(stats.range.from) : '';
  const max = Math.max(1, ...heat.cols.flatMap((c) => [c.fa4, c.fa3, c.other]));
  return (
    <section className={`${s.card} ${s.calls} ${s.zCalls}`} aria-label="Calls" data-testid="calls">
      <div className={s.zh}>
        <span className={s.ctot} aria-label={`${calls.total} ${calls.total === 1 ? 'call' : 'calls'} in range`} data-testid="calls-total">
          <b>{calls.total}</b>
          <span>calls</span>
        </span>
        {view === 'heat' ? (
          <span className={s.hlegend} aria-hidden>
            <b>0</b>
            {[0, 1, 2, 3, 4, 5].map((k) => (
              <i key={k} style={{ background: `var(--dv-heat-${k})` }} />
            ))}
            <b>{max}</b>
          </span>
        ) : (
          <span className={s.legend} aria-hidden>
            {view === 'tent'
              ? TENTS.map((t) => (
                  <span key={t}>
                    <i className={s.tw} style={{ background: TENT_VAR[t] }} />
                    {t}
                  </span>
                ))
              : null}
            {compare ? (
              <span>
                <i className={s.lk} />
                {prevName}
              </span>
            ) : null}
          </span>
        )}
        <span className={s.sp} />
        <SegmentedControl.Root size="1" radius="full" className={`${s.seg} ${s.segSm}`} value={view} onValueChange={(v) => isView(v) && onView(v)} aria-label="Calls view" data-testid="calls-view">
          {VIEWS.map(([k, l]) => (
            <SegmentedControl.Item key={k} value={k}>
              {l}
            </SegmentedControl.Item>
          ))}
        </SegmentedControl.Root>
        <button type="button" className={s.tbl} aria-pressed={table} aria-label="Show as a table" onClick={() => setTable((t) => !t)} data-testid="calls-table-toggle">
          <Table2 size={15} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      {table ? (
        <CallsTable stats={stats} view={view} range={range} />
      ) : view === 'heat' ? (
        <HeatChart cols={heat.cols} step={heat.step} phone={phone} event={range === 'event'} />
      ) : (
        <CallsChart range={range} buckets={calls.buckets} step={step} compare={compare} prevName={prevName} byTent={view === 'tent'} phone={phone} now={now} />
      )}
      <Recap stats={stats} compare={compare} prevName={prevName} skew={skew} />
    </section>
  );
}

function CallsTable({ stats, view, range }: { stats: Stats; view: CallsView; range: StatsRange }) {
  const step = stats.range?.step ?? 15;
  if (view === 'heat') {
    const heat = stats.heat ?? { step: 60, cols: [] };
    return (
      <div className={s.ttable}>
        <table>
          <thead>
            <tr>
              <th>Tent</th>
              {heat.cols.map((c, i) => (
                <th key={i}>{heatLabel(c, heat.step)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TENTS.map((t) => (
              <tr key={t}>
                <td>{t}</td>
                {heat.cols.map((c, i) => (
                  <td key={i}>{c[TENT_KEY[t]]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const compare = !!stats.range?.compare;
  return (
    <div className={s.ttable}>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            {TENTS.map((t) => (
              <th key={t}>{t}</th>
            ))}
            <th>Total</th>
            {compare ? <th>{prevNightName(stats.range!.from)}</th> : null}
          </tr>
        </thead>
        <tbody>
          {(stats.calls?.buckets ?? []).map((b) => (
            <tr key={b.at}>
              <td>{heatLabel({ ...b, at: b.at }, range === 'event' ? 60 : step === 15 ? 15 : 60)}</td>
              <td>{b.fa4}</td>
              <td>{b.fa3}</td>
              <td>{b.other}</td>
              <td>
                <b>{bucketTotal(b)}</b>
              </td>
              {compare ? <td>{b.prev ?? ''}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Delta({ cur, prev, decimals = 0, words, prevName }: { cur: number | null | undefined; prev: number | null | undefined; decimals?: number; words: [string, string]; prevName: string }) {
  const d = delta(cur, prev, decimals);
  if (!d) return null;
  return (
    <span className={s.dt} aria-label={`${d.text}${decimals ? ' minutes' : ''} ${words[d.d > 0 ? 0 : 1]} than ${prevName}`}>
      {d.glyph}
      {d.text}
    </span>
  );
}

function Recap({ stats, compare, prevName, skew }: { stats: Stats; compare: boolean; prevName: string; skew: number }) {
  const now = useServerNow(skew);
  const r = stats.recap;
  const reunited = r?.reunited ?? stats.reunited;
  const notLocated = r?.notLocated ?? stats.notInMedical;
  const last = r?.lastReunionAt ? (now - Date.parse(r.lastReunionAt)) / 60_000 : null;
  return (
    <div className={s.recap} data-testid="recap">
      <span className={s.rg}>
        <span>
          <StatusGlyph kind="closed" size={13} className={s.sg} />
          <b data-testid="recap-reunited">{reunited}</b> reunited
          {compare ? <Delta cur={r?.reunited} prev={r?.prevReunited} words={['more', 'fewer']} prevName={prevName} /> : null}
        </span>
        <span>
          <StatusGlyph kind="notInMedical" size={13} className={s.sg} />
          <b data-testid="recap-not-located">{notLocated}</b> not located
        </span>
      </span>
      <span className={s.rg}>
        <span>
          Fastest <b>{typeof r?.fastest !== 'number' ? NO_VALUE : `${fmtM(r.fastest)}m`}</b>
          {compare ? <Delta cur={r?.fastest} prev={r?.prevFastest} decimals={1} words={['slower', 'faster']} prevName={prevName} /> : null}
        </span>
        {last !== null ? (
          <span aria-label={`Last reunion ${Math.floor(last)} minutes ago`} data-testid="recap-last">
            Last reunion <b>{mmss(last)}</b> ago
          </span>
        ) : null}
      </span>
    </div>
  );
}

// ---- loading ------------------------------------------------------------------------------------------------------

function Loading({ phone }: { phone: boolean }) {
  return (
    <div className={phone ? `${s.dash} ${s.phone}` : `${s.dash} ${s.desk}`} aria-busy="true" data-testid="dashboard-loading">
      <Skeleton className={`${s.card} ${s.zStatus}`} height="64px" />
      <Skeleton className={`${s.card} ${s.zAtt}`} height="320px" />
      <Skeleton className={`${s.card} ${s.zSpd}`} height="140px" />
      <Skeleton className={`${s.card} ${s.zCalls}`} height="360px" />
    </div>
  );
}
