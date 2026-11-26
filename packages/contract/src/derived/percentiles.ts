import type { DerivedSchema } from "./ddl.ts";
import { PERCENTILE_SIGNALS, PERIODS } from "./values.ts";

/**
 * Returns the SQL statement that fills `period_percentiles` from `samples`. The statement computes
 * the P50 and P95 of each percentile signal for every week and month that has samples. Weeks start
 * on Monday. The statement uses `percentile_cont`, so
 * the stored values equal the percentiles that a query computes from the same samples. The statement only inserts rows, so run
 * it on an empty `period_percentiles`.
 */
export function periodPercentiles(schema: DerivedSchema): string {
  const periods = PERIODS.map(
    (period) => `('${period}', date_trunc('${period}', night::timestamp)::date)`,
  ).join(", ");
  const signals = PERCENTILE_SIGNALS.map((signal) => `('${signal}', ${signal})`).join(", ");

  return `
insert into ${schema}.period_percentiles (period, period_start, signal, p50, p95)
select period, period_start, signal,
  percentile_cont(0.5) within group (order by value),
  percentile_cont(0.95) within group (order by value)
from ${schema}.samples
cross join lateral (values ${periods}) as periods (period, period_start)
cross join lateral (values ${signals}) as signals (signal, value)
where value is not null
group by period, period_start, signal;
`;
}
