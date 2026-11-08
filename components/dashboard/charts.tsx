'use client';
// Dashboard v4 charts in plain SVG (design/screens/dashboard-v4.html callsSVG / heatSVG / sparkSVG): calls per bucket
// (one neutral colour, or stacked by tent) with the night before as a dashed line, hour × tent heat cells, and the
// speed sparkline. Values lead in the tooltip; each chart has a full-sentence aria-label.
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { CallsBucket, HeatCol, SpeedStat, StatsRange } from '@/lib/api-types';
import {
  TENTS,
  TENT_KEY,
  axisLabel,
  bucketHead,
  bucketTotal,
  heatBin,
  heatLabel,
  isCurrent,
  peakIndex,
  sparseStep,
  type Tent,
} from './dashboard-model';
import s from './dashboard.module.css';

export const TENT_VAR: Readonly<Record<Tent, string>> = { 'FA 4': 'var(--dv-tent-fa4)', 'FA 3': 'var(--dv-tent-fa3)', Other: 'var(--dv-tent-other)' };

/** The element's content box, kept current. */
function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((o) => (o.w === el.clientWidth && o.h === el.clientHeight ? o : { w: el.clientWidth, h: el.clientHeight }));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

function topRound(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

interface TipRow {
  v: number | string;
  name: string;
  color: string;
  dash?: boolean;
}
interface Tip {
  x: number;
  y: number;
  head: string;
  rows: TipRow[];
  total?: number;
}

function Tooltip({ tip, w }: { tip: Tip | null; w: number }) {
  if (!tip) return null;
  const left = tip.x + 160 > w ? Math.max(0, tip.x - 160) : tip.x + 14;
  return (
    <div className={s.tip} style={{ transform: `translate(${left}px, ${Math.max(0, tip.y - 20)}px)` }} aria-hidden>
      <div className={s.th}>{tip.head}</div>
      {tip.rows.map((r) => (
        <div key={r.name} className={s.tr}>
          <i className={r.dash ? s.kdash : s.k} style={r.dash ? undefined : { background: r.color }} />
          <span>{r.name}</span>
          <b>{r.v}</b>
        </div>
      ))}
      {tip.total !== undefined ? (
        <div className={`${s.tr} ${s.tot}`}>
          <i />
          <span>Total</span>
          <b>{tip.total}</b>
        </div>
      ) : null}
    </div>
  );
}

export interface CallsChartProps {
  range: StatsRange;
  buckets: readonly CallsBucket[];
  step: number;
  compare: boolean;
  prevName: string;
  byTent: boolean;
  phone: boolean;
  now: number;
}

export function CallsChart({ range, buckets: bs, step, compare, prevName, byTent, phone, now }: CallsChartProps) {
  const [ref, { w: W, h: H }] = useSize<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const [hover, setHover] = useState(-1);
  const ev = range === 'event';
  const padL = 22, padR = 4, padT = 22, padB = 22;
  const plotH = Math.max(10, H - padT - padB);
  const base = padT + plotH;
  const gap = ev ? 1.2 : 0;
  const nights = ev ? new Set(bs.map((b) => b.night)).size : 1;
  const slot = (W - padL - padR) / Math.max(1, bs.length + (nights - 1) * gap);
  const xs: number[] = [];
  let x = padL;
  bs.forEach((b, i) => {
    if (ev && i > 0 && b.night !== bs[i - 1]!.night) x += gap * slot;
    xs.push(x);
    x += slot;
  });
  const totals = bs.map(bucketTotal);
  const maxV = Math.max(1, ...totals, ...(compare ? bs.map((b) => b.prev ?? 0) : [0]));
  const stepY = sparseStep(maxV);
  const ymax = Math.ceil(maxV / stepY) * stepY;
  const y = (v: number) => base - (v / ymax) * plotH;
  const bw = Math.min(24, Math.max(3, slot * 0.68));
  const peak = peakIndex(bs);
  const grid: number[] = [];
  for (let v = 0; v <= ymax; v += stepY) grid.push(v);

  const move = (i: number) => (e: PointerEvent<SVGRectElement>) => {
    const b = bs[i]!;
    const box = ref.current!.getBoundingClientRect();
    const head = bucketHead(range, b, step) + (isCurrent(b, step, now) ? ' · so far' : '');
    const rows: TipRow[] = byTent ? TENTS.map((t) => ({ v: b[TENT_KEY[t]], name: t, color: TENT_VAR[t] })) : [{ v: totals[i]!, name: 'Calls', color: 'var(--dv-bar)' }];
    if (compare) rows.push({ v: b.prev ?? 0, name: prevName, color: '', dash: true });
    setHover(i);
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, head, rows, total: byTent ? totals[i] : undefined });
  };
  const leave = () => {
    setHover(-1);
    setTip(null);
  };

  const pb = peak >= 0 ? bs[peak]! : null;
  const label = `Calls per ${ev ? 'hour' : `${step} minutes`}${byTent ? ', stacked by tent' : ''}${compare ? `, ${prevName} as a dashed line` : ''}. ${totals.reduce((a, b) => a + b, 0)} in range.${pb ? ` Peak ${totals[peak]} at ${bucketHead(range, pb, step)}.` : ''}`;

  return (
    <div ref={ref} className={s.chart} data-testid="calls-chart">
      {W > 0 && H > 0 ? (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
          {grid.map((v) => (
            <g key={v}>
              <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="var(--dv-grid)" shapeRendering="crispEdges" />
              <text x={padL - 8} y={y(v) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--gray-11)" className={s.num}>
                {v}
              </text>
            </g>
          ))}
          {hover >= 0 ? <rect x={xs[hover]! + 1} y={padT - 8} width={slot - 2} height={plotH + 8} rx="4" fill="var(--gray-a3)" /> : null}
          {compare ? (
            <path
              d={bs.map((b, i) => `${i ? 'L' : 'M'}${(xs[i]! + slot / 2).toFixed(1)},${y(b.prev ?? 0).toFixed(1)}`).join('')}
              fill="none"
              stroke="var(--gray-12)"
              strokeWidth="1.5"
              strokeDasharray="4 3"
              strokeLinejoin="round"
              opacity=".4"
              data-testid="calls-prev"
            />
          ) : null}
          {bs.map((b, i) => {
            if (!totals[i]) return null;
            const bx = xs[i]! + (slot - bw) / 2;
            const cur = isCurrent(b, step, now);
            if (!byTent) {
              const top = y(totals[i]!);
              const d = topRound(bx, top, bw, base - top, 4);
              return cur ? (
                <path key={b.at} d={d} fill="var(--dv-bar)" fillOpacity=".22" stroke="var(--dv-bar)" strokeWidth="1.25" strokeDasharray="3 2" />
              ) : (
                <path key={b.at} d={d} fill="var(--dv-bar)" />
              );
            }
            let yb = base;
            const segs = TENTS.filter((t) => b[TENT_KEY[t]] > 0);
            return (
              <g key={b.at}>
                {segs.map((t, si) => {
                  const h = (b[TENT_KEY[t]] / ymax) * plotH;
                  const top = yb - h;
                  const hh = Math.max(1, (si === 0 ? yb : yb - 2) - top);
                  const d = si === segs.length - 1 ? topRound(bx, top, bw, hh, 4) : `M${bx},${top}H${bx + bw}V${top + hh}H${bx}Z`;
                  yb = top;
                  return cur ? (
                    <path key={t} d={d} fill={TENT_VAR[t]} fillOpacity=".28" stroke={TENT_VAR[t]} strokeWidth="1.25" strokeDasharray="3 2" />
                  ) : (
                    <path key={t} d={d} fill={TENT_VAR[t]} />
                  );
                })}
              </g>
            );
          })}
          {pb ? (
            <g>
              <circle cx={xs[peak]! + slot / 2} cy={y(totals[peak]!) - 7} r="4" fill="var(--gray-12)" stroke="var(--dv-card)" strokeWidth="2" />
              <text x={xs[peak]! + slot / 2} y={y(totals[peak]!) - 16} textAnchor="middle" fontSize="11.5" fontWeight="600" fill="var(--gray-12)" className={s.num}>
                {totals[peak]}
              </text>
            </g>
          ) : null}
          {bs.map((b, i) => {
            const text = axisLabel(range, b, i, bs, phone);
            if (text === null) return null;
            const short = range === '1h' || range === '2h';
            const lx = short ? xs[i]! + slot / 2 : xs[i]!;
            const anchor = ev ? 'start' : !short && lx - padL < 12 ? 'start' : 'middle';
            return (
              <text key={`l${b.at}`} x={ev ? lx + 1 : lx} y={base + 17} textAnchor={anchor} fontSize="10.5" fill="var(--gray-11)">
                {text}
              </text>
            );
          })}
          <g>
            {bs.map((b, i) => (
              <rect key={`h${b.at}`} x={xs[i]} y={padT - 10} width={slot} height={plotH + 10 + padB} fill="transparent" onPointerEnter={move(i)} onPointerMove={move(i)} onPointerLeave={leave} />
            ))}
          </g>
        </svg>
      ) : null}
      <Tooltip tip={tip} w={W} />
    </div>
  );
}

export interface HeatChartProps {
  cols: readonly HeatCol[];
  step: number;
  phone: boolean;
  event: boolean;
}

export function HeatChart({ cols, step, phone, event }: HeatChartProps) {
  const [ref, { w: W, h: fitH }] = useSize<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const [hover, setHover] = useState('');
  const n = Math.max(1, cols.length);
  const labelW = phone ? 48 : 60;
  const gap = 2;
  const cellH = phone ? 24 : Math.max(22, Math.min(64, Math.floor((fitH - 38 - 3 * gap) / 3)));
  const cw = (W - labelW) / n;
  const totalY = 3 * (cellH + gap) + 2;
  const axisY = totalY + 32;
  const H = axisY + 4;
  const max = Math.max(1, ...cols.flatMap((c) => TENTS.map((t) => c[TENT_KEY[t]])));
  let peak = { v: -1, ci: -1, ri: -1 };
  cols.forEach((c, ci) => TENTS.forEach((t, ri) => (c[TENT_KEY[t]] > peak.v ? (peak = { v: c[TENT_KEY[t]], ci, ri }) : null)));
  const every = cw < 30 ? 2 : 1;
  const label = `Calls by ${step === 15 ? '15 minutes' : 'hour'} and tent${event ? ', every night together' : ''}. Busiest cell ${Math.max(0, peak.v)}.`;
  return (
    <div ref={ref} className={`${s.chart} ${s.heat}`} data-testid="heat-chart">
      {W > 0 ? (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
          {TENTS.map((t, ri) => {
            const ry = ri * (cellH + gap);
            return (
              <g key={t}>
                <rect x="0" y={ry + cellH / 2 - 4} width="8" height="8" rx="2" fill={TENT_VAR[t]} />
                <text x="13" y={ry + cellH / 2 + 4} fontSize="12" fill="var(--gray-11)">
                  {t}
                </text>
                {cols.map((c, ci) => {
                  const v = c[TENT_KEY[t]];
                  const k = heatBin(v, max);
                  const cx = labelW + ci * cw + gap / 2;
                  const id = `${ri}:${ci}`;
                  return (
                    <g key={ci}>
                      <rect
                        x={cx}
                        y={ry}
                        width={Math.max(1, cw - gap)}
                        height={cellH}
                        rx="4"
                        fill={`var(--dv-heat-${k})`}
                        stroke={hover === id ? 'var(--gray-12)' : undefined}
                        strokeWidth="1.5"
                        data-heat={k}
                        onPointerEnter={(e) => {
                          const box = ref.current!.getBoundingClientRect();
                          setHover(id);
                          setTip({ x: e.clientX - box.left, y: e.clientY - box.top, head: `${t} · ${heatLabel(c, step)}${event ? ' · every night' : ''}`, rows: [{ v, name: t, color: `var(--dv-heat-${Math.max(1, k)})` }] });
                        }}
                        onPointerLeave={() => {
                          setHover('');
                          setTip(null);
                        }}
                      />
                      {peak.ci === ci && peak.ri === ri && v > 0 ? (
                        <text x={cx + (cw - gap) / 2} y={ry + cellH / 2 + 4} textAnchor="middle" fontSize="11.5" fontWeight="600" fill={`var(--dv-heat-ink-${k})`} pointerEvents="none">
                          {v}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </g>
            );
          })}
          <text x="0" y={totalY + 14} fontSize="12" fontWeight="500" fill="var(--gray-12)">
            Total
          </text>
          <line x1={labelW} x2={W} y1={totalY} y2={totalY} stroke="var(--gray-a4)" shapeRendering="crispEdges" />
          {cols.map((c, ci) => {
            const cx = labelW + ci * cw + cw / 2;
            const t = bucketTotal(c);
            return (
              <g key={`t${ci}`}>
                <text x={cx} y={totalY + 14} textAnchor="middle" fontSize="12" fontWeight="600" fill={t ? 'var(--gray-12)' : 'var(--gray-11)'} className={s.num}>
                  {t}
                </text>
                {ci % every === 0 ? (
                  <text x={cx} y={axisY} textAnchor="middle" fontSize="10.5" fill="var(--gray-11)">
                    {heatLabel(c, step)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      ) : null}
      <Tooltip tip={tip} w={W} />
    </div>
  );
}

/** The speed popover's sparkline: medians per bucket against the target (dotted), the bucket still filling dashed. */
export function Spark({ stat, w = 200, h = 24, now }: { stat: SpeedStat; w?: number; h?: number; now: number }): ReactNode {
  const pts = stat.spark;
  const n = pts.length;
  if (!n) return null;
  const pad = 4;
  const vals = pts.map((p) => p.median).filter((v): v is number => v !== null);
  const ymax = Math.max(stat.target * 1.25, ...vals) * 1.05;
  const y = (v: number) => pad + (h - 2 * pad) * (1 - v / ymax);
  const xAt = (i: number) => (n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - 2 * pad));
  const P = (i: number) => `${xAt(i).toFixed(1)},${y(pts[i]!.median!).toFixed(1)}`;
  const runs: number[][] = [];
  let run: number[] = [];
  pts.forEach((p, i) => {
    if (p.median === null || (i > 0 && pts[i - 1]!.night !== p.night)) {
      if (run.length) runs.push(run);
      run = [];
    }
    if (p.median !== null) run.push(i);
  });
  if (run.length) runs.push(run);
  const stepMs = n > 1 ? Date.parse(pts[1]!.at) - Date.parse(pts[0]!.at) : 3_600_000;
  const cur = n > 1 && Date.parse(pts[n - 1]!.at) + stepMs > now && pts[n - 1]!.median !== null && pts[n - 2]!.median !== null && pts[n - 2]!.night === pts[n - 1]!.night;
  const last = runs.length ? runs[runs.length - 1]!.at(-1)! : -1;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Median by ${stepMs <= 900_000 ? '15 minutes' : 'hour'} against the ${stat.target} minute target`}>
      <line x1="0" x2={w} y1={y(stat.target)} y2={y(stat.target)} stroke="var(--gray-a6)" strokeDasharray="2 2" />
      {runs.map((r) => {
        const solid = cur && r.at(-1) === n - 1 ? r.slice(0, -1) : r;
        return solid.length > 1 ? <polyline key={r[0]} points={solid.map(P).join(' ')} fill="none" stroke="var(--gray-11)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /> : null;
      })}
      {cur ? <polyline points={`${P(n - 2)} ${P(n - 1)}`} fill="none" stroke="var(--gray-11)" strokeWidth="1.5" strokeDasharray="2 2" strokeLinecap="round" /> : null}
      {last >= 0 ? <circle cx={xAt(last)} cy={y(pts[last]!.median!)} r="3" fill="var(--gray-12)" stroke="var(--dv-tip-bg)" strokeWidth="2" /> : null}
    </svg>
  );
}
