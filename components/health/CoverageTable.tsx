'use client';
// Alert coverage by team: devices seen (Home Screen, notifications granted, push subscribed, New requests on), the
// server's subscriptions, and how fast new-request alerts reached them (p50, share within 30 s).
import { Bell, CircleDot, MonitorSmartphone, Smartphone, SquareCheck, type Icon } from './icons';
import { Chip, Missing, NoRows } from './parts';
import { fmtMs, num, pct, teamLabel, type CoverageRow } from './health-model';
import s from './health.module.css';

const head = (Glyph: Icon, label: string) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
    <Glyph size={13} />
    {label}
  </span>
);

export function CoverageTable({ rows }: { rows: CoverageRow[] | null }) {
  if (!rows) return <Missing />;
  if (!rows.length) return <NoRows />;
  return (
    <table className={s.table} data-testid="health-coverage">
      <thead>
        <tr>
          <th scope="col">Team</th>
          <th scope="col" className={s.num}>
            {head(Smartphone, 'Devices')}
          </th>
          <th scope="col" className={s.num}>
            {head(MonitorSmartphone, 'Home Screen')}
          </th>
          <th scope="col" className={s.num}>
            {head(Bell, 'Allowed')}
          </th>
          <th scope="col" className={s.num}>
            {head(SquareCheck, 'Push')}
          </th>
          <th scope="col" className={s.num}>
            {head(CircleDot, 'New requests')}
          </th>
          <th scope="col" className={s.num}>
            Server
          </th>
          <th scope="col" className={s.num}>
            Alert p50
          </th>
          <th scope="col" className={s.num}>
            ≤ 30 s
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const share = r.alerts > 0 ? r.within30 / r.alerts : null;
          const color = share === null ? undefined : share >= 0.9 ? 'green' : share >= 0.6 ? 'amber' : 'red';
          const glyph = share === null ? '' : share >= 0.9 ? '✓ ' : '↓ ';
          return (
            <tr key={r.team}>
              <th scope="row" style={{ fontWeight: 500, textAlign: 'left' }}>
                {teamLabel(r.team)}
              </th>
              <td className={s.num}>{num(r.devices)}</td>
              <td className={s.num}>{num(r.standalone)}</td>
              <td className={s.num}>{num(r.granted)}</td>
              <td className={s.num}>{num(r.pushsub)}</td>
              <td className={s.num}>{num(r.newreq)}</td>
              <td className={s.num}>
                <Chip label={`${r.subs} push subscriptions on the server, ${r.subsNewreq} with New requests on.`}>
                  {num(r.subs)} · {num(r.subsNewreq)}
                </Chip>
              </td>
              <td className={s.num}>{fmtMs(r.p50)}</td>
              <td className={s.num}>
                {share === null ? (
                  '—'
                ) : (
                  <Chip color={color} label={`${pct(r.within30, r.alerts)} of ${r.alerts} new-request alerts arrived within 30 seconds.`}>
                    {glyph}
                    {pct(r.within30, r.alerts)}
                  </Chip>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
