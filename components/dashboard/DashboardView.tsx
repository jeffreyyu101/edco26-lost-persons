'use client';
// Dashboard (?dashboard=1, spec §8 Dashboard; design/screens/dashboard.html): GET /api/stats every 15 s
// while open via useStats(true). One hero number; a thin segmented bar (blue Waiting, green In medical,
// 2 px gap) with a legend of glyph + label + count; 4 tiles; Open by post as single-hue grey bars with the
// value at the tip; Recently updated; Export CSV. Legend rows, tiles and bars open All filtered (A22);
// Longest wait and Recently updated rows open that request.
import { Button, Heading, IconButton, Skeleton, Text } from '@radix-ui/themes';
import { ChevronLeft, Clock, Download, Timer } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import { EXPORT_CSV_PATH, handleExportClick } from '@/components/account/export-csv';
import type { Stats } from '@/lib/api-types';
import { goBack, navigate } from '@/lib/client/nav';
import { useConnection, useEventTimezone, useNow, useStats } from '@/lib/client/store-contract';
import { STATUS, postFilterKey, postFilterLabel, statusMeta, toneColorVar } from '@/lib/domain';
import { formatCaseNumber } from '@/lib/format';
import { barPercent, closedSubline, formatAgo, formatMinutes } from './dashboard-model';
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
  const { stats, error } = useStats(true);
  const { connection } = useConnection();
  const offline = connection === 'offline';
  const live = !offline && connection !== 'error' && !error;
  const pill = live ? 'Live' : offline ? 'Offline' : 'Retrying';

  return (
    <div className={s.app} data-testid="dashboard">
      <div className={s.nav}>
        <IconButton variant="ghost" color="gray" aria-label="Back to requests" className={s.back} onClick={() => goBack({})}>
          <ChevronLeft size={20} aria-hidden />
        </IconButton>
        <Heading as="h1" size="4" weight="medium">
          Dashboard
        </Heading>
        <span className={s.sp} />
        <span className={s.livepill} role="status" data-testid="dashboard-live">
          <span className={s.live} data-state={live ? 'on' : 'off'} aria-hidden />
          {pill}
        </span>
      </div>
      <main className={s.body}>
        {stats ? (
          <Content stats={stats} offline={offline} />
        ) : error ? (
          <EmptyState icon="plug" title="Can't reach the log" action={{ label: 'Try again', onClick: onRetry, icon: 'refresh' }} />
        ) : (
          <Loading />
        )}
      </main>
    </div>
  );
}

const showAll = (params: { status?: string; post?: string; open?: true }) => navigate(params);

function Content({ stats, offline }: { stats: Stats; offline: boolean }) {
  const timeZone = useEventTimezone();
  const now = useNow();
  const { waiting, inMedical } = stats.open;
  const open = waiting + inMedical;
  const segments: Array<{ status: string; count: number }> = [
    { status: STATUS.waiting, count: waiting },
    { status: STATUS.inMedical, count: inMedical },
  ];
  const maxPost = Math.max(1, ...stats.byPost.map((p) => p.count));
  const closedSub = closedSubline(stats);
  const longest = stats.longestWait;

  return (
    <>
      <section aria-label="Open requests">
        <Text size="2" color="gray">
          Open requests
        </Text>
        <div className={s.num} data-testid="open-count">
          {open}
        </div>
        <div
          className={s.seg}
          role="img"
          aria-label={segments.map((g) => `${statusMeta(g.status).label} ${g.count}`).join(', ')}
        >
          {open === 0 ? <span className={s.empty} /> : null}
          {segments.map((g) =>
            g.count > 0 ? (
              <span key={g.status} style={{ flex: g.count, background: toneColorVar(statusMeta(g.status).tone) }} />
            ) : null,
          )}
        </div>
        <div className={s.legend}>
          {segments.map((g) => (
            <button
              key={g.status}
              type="button"
              className={`${s.tap} ${s.lg}`}
              onClick={() => showAll({ status: g.status })}
              data-testid={`legend-${g.status === STATUS.waiting ? 'waiting' : 'in-medical'}`}
            >
              <StatusGlyph status={g.status} />
              <Text size="2">{statusMeta(g.status).label}</Text>
              <span className={s.sp} />
              <Text size="2" className={s.v}>
                {g.count}
              </Text>
            </button>
          ))}
        </div>
      </section>

      <section className={s.tiles} aria-label="Totals">
        <Tile
          testId="tile-not-in-medical"
          label={
            <>
              <StatusGlyph status={STATUS.notInMedical} size={12} />
              Not in medical
            </>
          }
          value={String(stats.notInMedical)}
          onClick={() => showAll({ status: STATUS.notInMedical })}
        />
        <Tile
          testId="tile-reunited"
          label={
            <>
              <StatusGlyph status={STATUS.reunited} size={12} />
              Reunited
            </>
          }
          value={String(stats.reunited)}
          sub={closedSub}
          onClick={() => showAll({ status: STATUS.reunited })}
        />
        <Tile
          testId="tile-longest-wait"
          label={
            <>
              <Clock size={13} aria-hidden />
              Longest wait
            </>
          }
          value={formatMinutes(longest?.minutes)}
          sub={longest ? [formatCaseNumber(longest.caseNumber), longest.postShort].filter(Boolean).join(' · ') : null}
          onClick={longest ? () => navigate({ r: longest.id }) : undefined}
        />
        <Tile
          testId="tile-avg-answer"
          label={
            <>
              <Timer size={13} aria-hidden />
              Avg answer time
            </>
          }
          value={formatMinutes(stats.avgAnswerMinutes)}
          sub="Last 2 hours"
        />
      </section>

      <section aria-labelledby="lp-dash-posts">
        <div className={s.sh}>
          <Heading as="h2" size="2" weight="medium" id="lp-dash-posts">
            Open by post
          </Heading>
        </div>
        <div className={s.bars}>
          {stats.byPost.map((p) => {
            // One filter key per bar: an Other location named like a fixed post ("Base"), or a legacy
            // 'FA 3' row, gets its own bar, label and filter (postFilterKey).
            const key = postFilterKey(p.reportingLocation, p.otherLocation);
            const label = postFilterLabel(p.reportingLocation, p.otherLocation) || p.postShort;
            return (
              <button
                key={key}
                type="button"
                className={`${s.tap} ${s.bar}`}
                // The bar counts open requests, so it opens exactly those (closed rows at the post stay out).
                onClick={() => showAll({ post: key, open: true })}
                // Starts with what the bar shows, "FA 3 – Kinetic 24" (WCAG 2.5.3).
                aria-label={`${label} ${p.count} open`}
              >
                <Text size="2" color="gray">
                  {label}
                </Text>{' '}
                <span className={s.track} aria-hidden>
                  {p.count > 0 ? <span className={s.fill} style={{ width: `${barPercent(p.count, maxPost)}%` }} /> : null}
                  <span className={s.bv}>{p.count}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {stats.recent.length > 0 ? (
        <section className={s.recent} aria-labelledby="lp-dash-recent">
          <div className={s.sh}>
            <Heading as="h2" size="2" weight="medium" id="lp-dash-recent">
              Recently updated
            </Heading>
          </div>
          {stats.recent.map((r) => {
            const meta = statusMeta(r.status);
            return (
              <button key={r.id} type="button" className={`${s.tap} ${s.row}`} onClick={() => navigate({ r: r.id })}>
                <StatusGlyph status={r.status} />
                <span className={s.rm}>
                  <Text size="2" weight="medium">
                    {r.name?.trim() || formatCaseNumber(r.caseNumber)}
                  </Text>
                  <Text size="1" weight="medium" color={meta.tone === 'gray' ? undefined : meta.tone}>
                    {meta.label}
                  </Text>
                </span>
                <span className={s.t}>{formatAgo(r.updatedAt, now, timeZone)}</span>
              </button>
            );
          })}
        </section>
      ) : null}

      {offline ? (
        <Button size="2" variant="soft" color="gray" disabled style={{ width: '100%' }}>
          <Download size={15} aria-hidden />
          Export CSV
        </Button>
      ) : (
        <Button asChild size="2" variant="soft" color="gray" className="lp-hit" style={{ width: '100%' }}>
          <a href={EXPORT_CSV_PATH} download onClick={handleExportClick}>
            <Download size={15} aria-hidden />
            Export CSV
          </a>
        </Button>
      )}
    </>
  );
}

function Tile({ label, value, sub, onClick, testId }: { label: ReactNode; value: string; sub?: string | null; onClick?: () => void; testId: string }) {
  const body = (
    <>
      <span className={s.lb}>{label}</span>
      <span className={s.val}>{value}</span>
      {sub ? <span className={s.sub}>{sub}</span> : null}
    </>
  );
  if (!onClick) {
    return (
      <div className={s.tile} data-testid={testId}>
        {body}
      </div>
    );
  }
  return (
    <button type="button" className={`${s.tap} ${s.tile}`} onClick={onClick} data-testid={testId}>
      {body}
    </button>
  );
}

function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading dashboard" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <Skeleton height="14px" width="110px" />
        <Skeleton height="56px" width="48px" style={{ margin: '8px 0 14px' }} />
        <Skeleton height="8px" width="100%" />
        <div style={{ display: 'grid', gap: 18, marginTop: 20 }}>
          <Skeleton height="14px" width="70%" />
          <Skeleton height="14px" width="80%" />
        </div>
      </div>
      <div className={s.tiles}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height="88px" style={{ borderRadius: 'var(--radius-4)' }} />
        ))}
      </div>
      <div style={{ display: 'grid', gap: 22 }}>
        <Skeleton height="14px" width="100px" />
        {[80, 45, 25, 10].map((w) => (
          <Skeleton key={w} height="12px" width={`${w}%`} />
        ))}
      </div>
    </div>
  );
}
