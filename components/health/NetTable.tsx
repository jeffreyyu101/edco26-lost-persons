'use client';
// Requests: one row per endpoint and method (n, failure rate = 5xx + network + timeout over n, 4xx apart, p50, p95),
// the split by network state under it, and the sync line (ok %, full fetches, p95 data age).
import { Fragment } from 'react';
import { Chip, Missing, NoRows } from './parts';
import { STATE_LABEL, fmtMs, num, pct, type NetSection } from './health-model';
import s from './health.module.css';

export function NetTable({ net }: { net: NetSection | null }) {
  if (!net) return <Missing />;
  const sync = net.sync;
  const syncTotal = (sync?.ok ?? 0) + (sync?.fail ?? 0);
  return (
    <>
      <div className={s.chips} style={{ marginBottom: 8 }} data-testid="health-sync">
        <Chip label={`Syncs succeeded: ${pct(sync?.ok, syncTotal)} of ${num(syncTotal)}.`}>
          syncs {pct(sync?.ok, syncTotal)}
        </Chip>
        <Chip label={`${num(sync?.full)} full fetches.`}>full {num(sync?.full)}</Chip>
        <Chip label={`Data age, 95th percentile: ${num(sync?.ageP95)} seconds.`}>age p95 {typeof sync?.ageP95 === 'number' ? `${Math.round(sync.ageP95)} s` : '—'}</Chip>
      </div>
      {net.rows.length === 0 ? (
        <NoRows />
      ) : (
        <table className={s.table} data-testid="health-net">
          <thead>
            <tr>
              <th scope="col">Endpoint</th>
              <th scope="col" className={s.num}>
                n
              </th>
              <th scope="col" className={s.num}>
                Failed
              </th>
              <th scope="col" className={s.num}>
                4xx
              </th>
              <th scope="col" className={s.num}>
                p50
              </th>
              <th scope="col" className={s.num}>
                p95
              </th>
            </tr>
          </thead>
          <tbody>
            {net.rows.map((r) => (
              <Fragment key={`${r.pattern}|${r.m}`}>
                <tr data-testid="health-net-row" data-pattern={r.pattern}>
                  <td className={s.mono}>
                    {(r.m ?? 'get').toUpperCase()} {r.pattern}
                  </td>
                  <td className={s.num}>{num(r.n)}</td>
                  <td className={s.num}>{pct(r.failed, r.n)}</td>
                  <td className={s.num}>{num(r.c4xx)}</td>
                  <td className={s.num}>{fmtMs(r.p50)}</td>
                  <td className={s.num}>{fmtMs(r.p95)}</td>
                </tr>
                <tr>
                  <td colSpan={6} style={{ paddingTop: 0 }}>
                    <span className={s.chips}>
                      {Object.entries(r.states ?? {}).map(([state, v]) => (
                        <Chip key={state} color={v.failed > 0 ? 'amber' : undefined} label={`While ${STATE_LABEL[state] ?? state}: ${pct(v.failed, v.n)} of ${v.n} failed.`}>
                          {STATE_LABEL[state] ?? state} {pct(v.failed, v.n)}
                        </Chip>
                      ))}
                      {r.timeouts > 0 ? (
                        <Chip color="red" label={`${r.timeouts} timed out.`}>
                          timeouts {r.timeouts}
                        </Chip>
                      ) : null}
                    </span>
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
