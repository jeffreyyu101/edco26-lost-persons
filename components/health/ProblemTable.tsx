'use client';
// Problem spots: frustration signals by place, ranked by devices then count. A row's ⋯ opens its example trails.
import { Ellipsis } from './icons';
import { Bar, Missing, NoRows, SignalChip, TeamChips } from './parts';
import { ago, problemSentence, signalLabel, type Problem } from './health-model';
import s from './health.module.css';

export function ProblemTable({ rows, now, onTrail }: { rows: Problem[] | null; now: number; onTrail: (p: Problem) => void }) {
  if (!rows) return <Missing />;
  if (!rows.length) return <NoRows />;
  const maxDevices = Math.max(...rows.map((r) => r.devices), 1);
  return (
    <table className={s.table} data-testid="health-problems">
      <thead>
        <tr>
          <th scope="col">Signal</th>
          <th scope="col">Where</th>
          <th scope="col" className={s.num}>
            Count
          </th>
          <th scope="col" className={s.num}>
            Devices
          </th>
          <th scope="col">Teams</th>
          <th scope="col" className={s.num}>
            Last
          </th>
          <th scope="col">
            <span className={s.sr}>Trail</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p, i) => {
          const sentence = problemSentence(p, now);
          return (
            <tr key={`${p.name}|${p.view}|${p.area}|${p.ctl}|${i}`} data-testid="health-problem" data-signal={p.name}>
              <td>
                <SignalChip name={p.name} label={sentence} />
              </td>
              <td className={s.mono}>
                {p.view ?? '?'} › {p.area ?? '?'}
                {p.ctl ? ` · ${p.ctl}` : ''}
              </td>
              <td className={s.num}>{p.n}</td>
              <td className={s.num}>
                {p.devices} <Bar value={p.devices} max={maxDevices} label={`${p.devices} of up to ${maxDevices} devices`} />
              </td>
              <td>
                <TeamChips teams={p.teams} />
              </td>
              <td className={s.num}>{ago(p.lastAt, now)}</td>
              <td>
                <button type="button" className={s.iconBtn} data-ghost="" aria-label={`Trail of ${signalLabel(p.name)} in ${p.area ?? 'this place'}`} onClick={() => onTrail(p)} disabled={!p.examples.length} data-testid="health-trail-open">
                  <Ellipsis size={16} />
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
