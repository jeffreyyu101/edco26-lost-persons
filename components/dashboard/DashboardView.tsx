'use client';
// Dashboard (?dashboard=1, spec §8 Dashboard): Jeffrey's global view, built from design/screens/polish-v7.html
// (Dash, Tiles, Posts, Recent, Perf, Laptop; renders v7-dash.png and v7-laptop.png). GET /api/stats every 15 s
// while open via useStats(true).
//   title    ‹ Dashboard, large, with the line under it (v2.2 afternoon): "Updated just now" / "Updated 5 min
//            ago" from the last stats fetch and Refresh now (fetches the stats at once); while fetches fail or
//            the phone is offline, the Reconnecting / Offline banner under the header and "Last updated 3:42 PM".
//   tiles    Open (blue/green split bar) and Closed, big; Waiting for check, In medical, Not found in medical, Reunited
//            (+ discharged · cancelled when either is non-zero). Status tiles open All filtered (A22); Open opens
//            Pending, which lists exactly the open requests.
//   posts    Open by post, busiest first: label over a 6 px bar, count in a fixed column. Opens ?post=&open=1 (A42).
//   recent   "Recently updated ›" opens All. Rows: number, name, status, updated; a row opens the profile.
//   perf     Longest wait (opens that request), Time to answer, Time to reunite, Logged. "—" when a value is null
//            or missing (avgReuniteMinutes / loggedLastHour come from the v2.2 lp_stats).
// ≥ 768 px (inside the desk shell, components/desk): the shell's top bar is the title and holds the line and
//            Refresh now beside it (the dashboard publishes their inputs through connection-signal.ts), so
//            there is no title row here; the Reconnecting / Offline banner stays at the top of the column.
//            Tiles are 3 × 2 (open statuses over closed ones), six in one row from 1024 px when the column
//            has room (not with a request docked beside it); values share one line across a row. Open by
//            post and Recently updated sit side by side and Performance rows in two columns when the column
//            has room, stacked when a request is docked. Sized by the main column (container queries).
import { Skeleton, VisuallyHidden } from '@radix-ui/themes';
import { ChevronLeft, ChevronRight, Clock, Inbox, Timer, Users, type LucideIcon } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useInDesk } from '@/components/desk/desk-context';
import { ConnectionBanner } from '@/components/ui/Banner';
import { EmptyState } from '@/components/ui/EmptyState';
import { LiveIndicator } from '@/components/ui/LiveIndicator';
import { StageGlyph } from '@/components/ui/StageGlyph';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import type { Stats } from '@/lib/api-types';
import { goBack, navigate } from '@/lib/client/nav';
import { useNow, useRequests, useStats } from '@/lib/client/store-contract';
import { useLiveStatus } from '@/lib/client/use-live-status';
import { STATUS, postFilterKey, postFilterLabel, statusMeta, toneColorVar } from '@/lib/domain';
import { stageLook, stagePhrase } from '@/lib/stages';
import {
  NO_VALUE,
  agoPhrase,
  barPercent,
  closedSubline,
  closedSublinePhrase,
  closedTotal,
  countParts,
  durationParts,
  durationPhrase,
  formatAgo,
  postsBusiestFirst,
  type ValuePart,
} from './dashboard-model';
import { setDashboardLive } from './connection-signal';
import s from './dashboard.module.css';

export type DashboardViewProps = Record<string, never>;

export function DashboardView(_props: DashboardViewProps) {
  // "Try again" remounts the poller, which fetches at once.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  return <Dashboard key={attempt} onRetry={() => setAttempt((n) => n + 1)} />;
}

function Dashboard({ onRetry }: { onRetry: () => void }) {
  const { stats, error, failing, updatedAt, refresh } = useStats(true);
  const inDesk = useInDesk();
  // The line, the banner and its live region share one status: the last stats fetch (the numbers on this page),
  // by the lists' rules (one failed poll shows nothing; 2 network failures or 3 server errors in a row do).
  const live = useLiveStatus({ syncedAt: updatedAt, failing, subject: 'Dashboard' });

  // On the desk the top bar draws the line and Refresh now from the same inputs; it drops them when the
  // dashboard closes.
  useEffect(() => {
    if (inDesk) setDashboardLive({ syncedAt: updatedAt, failing, refresh });
  }, [inDesk, updatedAt, failing, refresh]);
  useEffect(() => () => setDashboardLive(null), []);

  return (
    <div className={s.app} data-testid="dashboard">
      {inDesk ? null : (
        <header className={s.nav}>
          <button type="button" className={s.back} aria-label="Back to requests" onClick={() => goBack({})}>
            <ChevronLeft size={24} strokeWidth={2} aria-hidden />
          </button>
          <h1 className={s.title}>Dashboard</h1>
          <LiveIndicator className={s.live} line={live} onRefresh={refresh} />
        </header>
      )}
      <div className={s.banner}>
        <ConnectionBanner status={live} />
      </div>
      <main className={s.body}>
        {stats ? (
          <DashboardContent stats={stats} />
        ) : error ? (
          <EmptyState icon="plug" title="Can't reach the log" action={{ label: 'Try again', onClick: onRetry, icon: 'refresh' }} />
        ) : (
          <Loading />
        )}
      </main>
    </div>
  );
}

const show = (params: Parameters<typeof navigate>[0]) => navigate(params);

/** Everything under the title, for a loaded Stats (exported for the server-render unit tests). */
export function DashboardContent({ stats }: { stats: Stats }) {
  const now = useNow();
  return (
    <>
      <Tiles stats={stats} />
      <div className={s.grid2}>
        <Posts stats={stats} />
        <Recent stats={stats} now={now} />
      </div>
      <Performance stats={stats} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------------------------------

function Tiles({ stats }: { stats: Stats }) {
  const { waiting, inMedical } = stats.open;
  // Wraps only after the "·" when the tile is narrow: "+1 discharged ·" / "1 cancelled".
  const sub = closedSubline(stats)?.replace(/ /g, '\u00a0').replace('·\u00a0', '· ') ?? null;
  const subPhrase = closedSublinePhrase(stats);
  return (
    <section className={s.tiles} aria-label="Totals">
      <Tile
        big
        testId="tile-open"
        label="Open"
        value={waiting + inMedical}
        valueTestId="open-count"
        extra={<Split waiting={waiting} inMedical={inMedical} />}
        onClick={() => show({ view: 'pending' })}
      />
      <Tile
        big
        closed
        className={s.tileClosed}
        testId="tile-closed"
        glyph={<StatusGlyph kind="closed" />}
        label="Closed"
        value={closedTotal(stats)}
        // Keeps the two big numbers on one baseline (the Open tile has its split bar there).
        extra={<span className={`${s.split} ${s.ghost}`} aria-hidden />}
      />
      <Tile
        testId="tile-waiting"
        glyph={<StatusGlyph status={STATUS.waiting} />}
        label={statusMeta(STATUS.waiting).shortLabel}
        value={waiting}
        onClick={() => show({ status: STATUS.waiting })}
      />
      <Tile
        testId="tile-in-medical"
        glyph={<StatusGlyph status={STATUS.inMedical} />}
        label={statusMeta(STATUS.inMedical).shortLabel}
        value={inMedical}
        onClick={() => show({ status: STATUS.inMedical })}
      />
      <Tile
        closed
        className={s.tileLate}
        testId="tile-not-in-medical"
        glyph={<StatusGlyph status={STATUS.notInMedical} />}
        label={statusMeta(STATUS.notInMedical).shortLabel}
        value={stats.notInMedical}
        // Same height as the Reunited tile beside it when that one has its second line.
        sub={sub ? <span className={`${s.sub} ${s.ghost}`} aria-hidden>{sub}</span> : null}
        onClick={() => show({ status: STATUS.notInMedical })}
      />
      <Tile
        closed
        className={s.tileLate}
        testId="tile-reunited"
        glyph={<StatusGlyph status={STATUS.reunited} />}
        label={statusMeta(STATUS.reunited).shortLabel}
        value={stats.reunited}
        sub={
          sub ? (
            <span className={s.sub} data-testid="reunited-sub">
              <span aria-hidden>{sub}</span>
              <VisuallyHidden>{subPhrase}</VisuallyHidden>
            </span>
          ) : null
        }
        onClick={() => show({ status: STATUS.reunited })}
      />
    </section>
  );
}

interface TileProps {
  testId: string;
  label: string;
  value: number;
  glyph?: ReactNode;
  valueTestId?: string;
  big?: boolean;
  closed?: boolean;
  className?: string;
  /** Under the value: the Open split bar (or its invisible twin). */
  extra?: ReactNode;
  /** A small grey line under the value. */
  sub?: ReactNode;
  onClick?: () => void;
}

function Tile({ testId, label, value, glyph, valueTestId, big, closed, className, extra, sub, onClick }: TileProps) {
  const cls = [s.tile, big ? s.big : '', closed ? s.cl : '', className ?? ''].filter(Boolean).join(' ');
  const body = (
    <>
      <span className={s.lb}>
        {glyph}
        <span>{label}</span>
      </span>{' '}
      <span className={s.vw}>
        <span className={s.v} data-testid={valueTestId ?? `${testId}-value`}>
          {value}
        </span>
        {extra}
        {sub}
      </span>
    </>
  );
  if (!onClick) {
    return (
      <div className={cls} data-testid={testId}>
        {body}
      </div>
    );
  }
  return (
    <button type="button" className={`${s.tap} ${cls}`} onClick={onClick} data-testid={testId}>
      {body}
    </button>
  );
}

/** Open's 4 px bar: blue Waiting, then green In medical, 2 px apart (the tiles below carry the counts). */
function Split({ waiting, inMedical }: { waiting: number; inMedical: number }) {
  const segments = [
    { status: STATUS.waiting, count: waiting },
    { status: STATUS.inMedical, count: inMedical },
  ].filter((g) => g.count > 0);
  return (
    <span className={s.split} aria-hidden data-testid="open-split">
      {segments.length === 0 ? <span className={s.splitEmpty} /> : null}
      {segments.map((g) => (
        <span key={g.status} data-status={g.status} style={{ flex: g.count, background: toneColorVar(statusMeta(g.status).tone) }} />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------
// Open by post
// ---------------------------------------------------------------------------------------------------

function Posts({ stats }: { stats: Stats }) {
  const posts = postsBusiestFirst(stats.byPost);
  const max = Math.max(0, ...posts.map((p) => p.count));
  return (
    <section aria-labelledby="lp-dash-posts">
      <h2 className={s.sh} id="lp-dash-posts">
        Open by post
      </h2>
      <div className={s.posts}>
        {posts.map((p) => {
          // One filter key per bar: an Other location named like a fixed post ("Base"), or a legacy 'FA 3' row,
          // gets its own bar, label and filter (postFilterKey).
          const key = postFilterKey(p.reportingLocation, p.otherLocation);
          const label = postFilterLabel(p.reportingLocation, p.otherLocation) || p.postShort;
          return (
            <button
              key={key}
              type="button"
              className={`${s.tap} ${s.post}`}
              data-zero={p.count === 0 ? '' : undefined}
              // The bar counts open requests, so it opens exactly those (closed rows at the post stay out, A42).
              onClick={() => show({ post: key, open: true })}
              // Starts with what the row shows, "FA 3 – Kinetic 3" (WCAG 2.5.3).
              aria-label={`${label} ${p.count} open`}
            >
              <span className={s.pl}>{label}</span>{' '}
              <span className={s.trk} aria-hidden>
                {p.count > 0 ? <span style={{ width: `${barPercent(p.count, max)}%` }} /> : null}
              </span>{' '}
              <span className={s.pc}>{p.count}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------
// Recently updated
// ---------------------------------------------------------------------------------------------------

const NO_NAME = 'No name';

function Recent({ stats, now }: { stats: Stats; now: number }) {
  // (F5) A synced row knows its stage (Not found yet, …); lp_stats' recent rows only carry the status.
  const rows = useRequests();
  const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  if (stats.recent.length === 0) return null;
  return (
    <section aria-label="Recently updated" className={s.recent}>
      <h2 className={s.sh}>
        <button type="button" className={s.shLink} onClick={() => show({})} aria-label="Recently updated. Show all requests">
          Recently updated
          <ChevronRight size={18} strokeWidth={2.25} aria-hidden />
        </button>
      </h2>
      <div className={s.rlist}>
        {stats.recent.map((r) => {
          const meta = statusMeta(r.status);
          const live = byId.get(r.id);
          const look = live && live.status === r.status ? stageLook(live, now) : { ...meta, label: meta.shortLabel, glyph: meta.glyph };
          const closed = meta.bucket === 'closed';
          const name = r.name?.trim() || '';
          const ago = formatAgo(r.updatedAt, now);
          const shown = `${r.caseNumber} ${name || NO_NAME} ${look.label} ${ago}`;
          return (
            <button
              key={r.id}
              type="button"
              className={`${s.tap} ${s.rrow}`}
              data-closed={closed ? '' : undefined}
              data-request-id={r.id}
              onClick={() => show({ r: r.id })}
              aria-label={`${shown}. ${look.label !== meta.shortLabel && live ? stagePhrase(live, undefined, now) : meta.label}, ${r.postShort}, updated ${agoPhrase(r.updatedAt, now)}.`}
            >
              <span className={s.num}>{r.caseNumber}</span>{' '}
              <span className={s.nm} data-empty={name ? undefined : ''}>
                {name || NO_NAME}
              </span>{' '}
              <span className={s.st} data-tone={look.tone}>
                <StageGlyph glyph={look.glyph} />
                {look.label}
              </span>{' '}
              <span className={s.up}>{ago}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------------------------------

function Performance({ stats }: { stats: Stats }) {
  const longest = stats.longestWait;
  const longestContext = longest ? [String(longest.caseNumber), longest.postShort].filter(Boolean).join(' · ') : null;
  const answer = durationPhrase(stats.avgAnswerMinutes);
  const reunite = durationPhrase(stats.avgReuniteMinutes);
  const logged = countParts(stats.loggedLastHour);
  return (
    <section aria-labelledby="lp-dash-perf" className={s.perf}>
      <h2 className={s.sh} id="lp-dash-perf">
        Performance
      </h2>
      <div className={s.prows}>
        <PerfRow
          testId="perf-longest-wait"
          icon={Clock}
          label="Longest wait"
          context={longestContext}
          parts={longest ? durationParts(longest.minutes) : null}
          phrase={
            longest
              ? `Request ${longest.caseNumber} at ${longest.postShort} has been waiting ${durationPhrase(longest.minutes) ?? 'an unknown time'}. Opens the request.`
              : 'Longest wait: nobody is waiting for a check.'
          }
          onClick={longest ? () => show({ r: longest.id }) : undefined}
        />
        <PerfRow
          testId="perf-answer"
          icon={Timer}
          label="Time to answer"
          context="avg, 2 h"
          parts={durationParts(stats.avgAnswerMinutes)}
          phrase={`Average time to answer over the last 2 hours: ${answer ?? 'no answers yet'}.`}
        />
        <PerfRow
          testId="perf-reunite"
          icon={Users}
          label="Time to reunite"
          context="avg"
          parts={durationParts(stats.avgReuniteMinutes)}
          phrase={`Average time to reunite: ${reunite ?? 'not available'}.`}
        />
        <PerfRow
          testId="perf-logged"
          icon={Inbox}
          label="Logged"
          context="last hour"
          parts={logged}
          phrase={
            logged ? `Logged in the last hour: ${stats.loggedLastHour} ${stats.loggedLastHour === 1 ? 'request' : 'requests'}.` : 'Logged in the last hour: not available.'
          }
        />
      </div>
    </section>
  );
}

interface PerfRowProps {
  testId: string;
  icon: LucideIcon;
  label: string;
  context: string | null;
  parts: ValuePart[] | null;
  /** The row as a sentence, for screen readers (after the visible text when the row is a button). */
  phrase: string;
  onClick?: () => void;
}

function PerfRow({ testId, icon: Icon, label, context, parts, phrase, onClick }: PerfRowProps) {
  // What the row shows, as text: "Longest wait 1010 · FA 4 24m" (a button's name starts with it, WCAG 2.5.3).
  const shown = [label, context, parts ? parts.map((p) => `${p.value}${p.unit}`).join(' ') : NO_VALUE].filter(Boolean).join(' ');
  const visual = (
    <>
      <Icon size={16} className={s.ki} aria-hidden />
      <span className={s.kv} aria-hidden>
        <span className={s.k}>{label}</span>{' '}
        {context ? (
          <>
            <span className={s.m} data-testid={`${testId}-context`}>
              {context}
            </span>{' '}
          </>
        ) : null}
        <span className={s.sp} />
        <span className={s.pv} data-testid={`${testId}-value`}>
          {parts ? (
            parts.map((p, i) => (
              <Fragment key={i}>
                {i > 0 ? ' ' : null}
                <span className={s.val}>{p.value}</span>
                {p.unit ? <span className={s.u}>{p.unit}</span> : null}
              </Fragment>
            ))
          ) : (
            <span className={`${s.val} ${s.none}`}>{NO_VALUE}</span>
          )}
        </span>
      </span>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={`${s.tap} ${s.pr}`} onClick={onClick} aria-label={`${shown}. ${phrase}`} data-testid={testId}>
        {visual}
      </button>
    );
  }
  return (
    <div className={s.pr} data-testid={testId}>
      {visual}
      <VisuallyHidden>{phrase}</VisuallyHidden>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------------

/** Tile placeholders: the phone's two big and four small, or the desk's six alike. */
const LOADING_TILES = [104, 104, 74, 74, 74, 74];
const LOADING_TILES_DESK = [92, 92, 92, 92, 92, 92];

function Loading() {
  const inDesk = useInDesk();
  return (
    <div aria-busy="true" aria-label="Loading dashboard" className={s.loading}>
      <div className={s.tiles}>
        {(inDesk ? LOADING_TILES_DESK : LOADING_TILES).map((h, i) => (
          <Skeleton key={i} height={`${h}px`} style={{ borderRadius: 12 }} />
        ))}
      </div>
      <div className={s.loadingRows}>
        <Skeleton height="18px" width="120px" />
        {[100, 100, 40, 0].map((w, i) => (
          <div key={i} className={s.loadingPost}>
            <Skeleton height="12px" width="30%" />
            <Skeleton height="6px" width={`${Math.max(w, 4)}%`} />
          </div>
        ))}
      </div>
    </div>
  );
}
