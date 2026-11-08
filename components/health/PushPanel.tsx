'use client';
// Push: per kind, the server's ok / gone / failed, received on devices, shown, opened, the open rate and transit.
// Phones hand over their worker's log when the app opens, so "received" counts so far (the · chip).
import { Chip, Missing, NoRows } from './parts';
import { fmtMs, num, pct, type PushRow } from './health-model';
import s from './health.module.css';

export function PushPanel({ rows }: { rows: PushRow[] | null }) {
  if (!rows) return <Missing />;
  if (!rows.length) return <NoRows />;
  return (
    <table className={s.table} data-testid="health-push">
      <thead>
        <tr>
          <th scope="col">Kind</th>
          <th scope="col" className={s.num}>
            Sent
          </th>
          <th scope="col" className={s.num}>
            Received
          </th>
          <th scope="col" className={s.num}>
            Opened
          </th>
          <th scope="col" className={s.num}>
            Transit
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.kind ?? 'none'}>
            <td className={s.mono}>{r.kind ?? '?'}</td>
            <td className={s.num}>
              <Chip color={r.failed + r.gone > 0 ? 'amber' : 'green'} label={`${r.ok} delivered to the push service, ${r.gone} gone, ${r.failed} failed.`}>
                ✓{num(r.ok)}
                {r.gone ? ` ⊘${r.gone}` : ''}
                {r.failed ? ` ✕${r.failed}` : ''}
              </Chip>
            </td>
            <td className={s.num}>
              {num(r.rx)}{' '}
              <Chip label={`Received so far; ${r.shown} shown as a notification.`}>· {num(r.shown)}</Chip>
            </td>
            <td className={s.num}>
              {num(r.opened)} <span className={s.sub}>{pct(r.opened, r.rx)}</span>
            </td>
            <td className={s.num}>
              {fmtMs(r.t50)} <span className={s.sub}>{fmtMs(r.t95)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
