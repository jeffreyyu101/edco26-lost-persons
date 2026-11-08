'use client';
// Errors, newest first: time, type, source (chunk:hash:line:col), view, teams, count by fingerprint and devices.
import { Chip, Missing, NoRows, TeamChips } from './parts';
import { fmtClock, num, type ErrorRow } from './health-model';
import s from './health.module.css';

export function ErrorList({ rows, timeZone }: { rows: ErrorRow[] | null; timeZone?: string }) {
  if (!rows) return <Missing />;
  if (!rows.length) return <NoRows />;
  return (
    <table className={s.table} data-testid="health-errors">
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Type</th>
          <th scope="col">Source</th>
          <th scope="col">View</th>
          <th scope="col">Teams</th>
          <th scope="col" className={s.num}>
            Count
          </th>
          <th scope="col" className={s.num}>
            Devices
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.fp}|${i}`}>
            <td className={s.num}>{fmtClock(r.lastAt, timeZone)}</td>
            <td>
              <Chip color="red" label={`Error type ${r.type ?? 'unknown'}`}>
                ⚠ {r.type ?? '?'}
              </Chip>
            </td>
            <td className={s.mono}>
              {r.src ?? '?'}
              {r.line ? `:${r.line}` : ''}
              {r.col ? `:${r.col}` : ''}
            </td>
            <td className={s.mono}>{r.views.filter(Boolean).join(' ') || '?'}</td>
            <td>
              <TeamChips teams={r.teams} />
            </td>
            <td className={s.num}>×{num(r.n)}</td>
            <td className={s.num}>{num(r.devices)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
