'use client';
// Critical paths: n, p50, p95 and a p95 bar against the path's target, ✓ / ↑ / ↑↑ with its colour; outcome chips.
import { Bar, Chip, Missing } from './parts';
import { GRADE_COLOR, GRADE_GLYPH, GRADE_WORDS, fmtMs, grade, sayMs, summarizePaths, type FlowRow } from './health-model';
import s from './health.module.css';

export function PathTable({ rows }: { rows: FlowRow[] | null }) {
  if (!rows) return <Missing />;
  const paths = summarizePaths(rows);
  return (
    <table className={s.table} data-testid="health-paths">
      <thead>
        <tr>
          <th scope="col">Path</th>
          <th scope="col" className={s.num}>
            n
          </th>
          <th scope="col" className={s.num}>
            p50
          </th>
          <th scope="col" className={s.num}>
            p95
          </th>
          <th scope="col">Target</th>
          <th scope="col">Outcomes</th>
        </tr>
      </thead>
      <tbody>
        {paths.map((p) => {
          const g = grade(p.p95, p.def.target);
          const target = p.def.target;
          return (
            <tr key={p.def.name} data-testid="health-path" data-path={p.def.name}>
              <th scope="row" style={{ fontWeight: 400, textAlign: 'left' }}>
                {p.def.label}
              </th>
              <td className={s.num}>{p.n}</td>
              <td className={s.num}>{fmtMs(p.p50)}</td>
              <td className={s.num}>{fmtMs(p.p95)}</td>
              <td>
                {target !== null && p.p95 !== null ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Bar value={p.p95} max={target * 2} color={GRADE_COLOR[g]} label={`95th percentile ${sayMs(p.p95)} against a target of ${sayMs(target)}: ${GRADE_WORDS[g]}.`} />
                    <span className={s.glyph} data-color={GRADE_COLOR[g]} aria-hidden>
                      {GRADE_GLYPH[g]}
                    </span>
                  </span>
                ) : null}
              </td>
              <td>
                <span className={s.chips}>
                  {p.outs.slice(0, 4).map((o) => (
                    <Chip key={o.out} label={`${o.n} ${o.out.replace(/_/g, ' ')}`}>
                      {o.out} {o.n}
                    </Chip>
                  ))}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
