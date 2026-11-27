import { valuesOf } from "../enum.ts";
import type { DerivedSchema } from "./ddl.ts";
import { PercentileSignal, Period } from "./values.ts";

const SIGNALS = valuesOf(PercentileSignal)
  .map((signal) => `('${signal}', ${signal})`)
  .join(", ");
const PERCENTILES = `percentile_cont(0.5) within group (order by value),
  percentile_cont(0.95) within group (order by value)`;

/**
 * Returns the SQL statement that fills an empty `period_percentiles` from `samples`. The statement
 * computes the P50 and P95 of each percentile signal for every week and month that has samples.
 * Weeks start on Monday. The statement uses `percentile_cont`, so the stored values equal the
 * percentiles that a query computes from the same samples.
 */
export function periodPercentiles(schema: DerivedSchema): string {
  const periods = valuesOf(Period)
    .map((period) => `('${period}', date_trunc('${period}', night::timestamp)::date)`)
    .join(", ");

  return `
insert into ${schema}.period_percentiles (period, period_start, signal, p50, p95)
select period, period_start, signal, ${PERCENTILES}
from ${schema}.samples
cross join lateral (values ${periods}) as periods (period, period_start)
cross join lateral (values ${SIGNALS}) as signals (signal, value)
where value is not null
group by period, period_start, signal;
`;
}

/**
 * Returns the SQL that recomputes the `period_percentiles` rows for each week and month that
 * contains one of `nights`. It computes each period once and stores the same values that
 * `periodPercentiles` stores. The SQL deletes those rows, then inserts new rows computed from only
 * the samples inside those periods.
 */
export function recomputePeriodPercentiles(
  schema: DerivedSchema,
  nights: readonly [Temporal.PlainDate, ...Temporal.PlainDate[]],
): string {
  const dates = nights.map((night) => `'${night.toString()}'`).join(", ");
  const periods = valuesOf(Period)
    .map((period) => `('${period}')`)
    .join(", ");
  const touched = `with touched (period, period_start) as (
  select distinct period, date_trunc(period, night::timestamp)::date
  from unnest(array[${dates}]::date[]) as nights (night)
  cross join (values ${periods}) as p (period)
)`;

  return `
${touched}
delete from ${schema}.period_percentiles
where (period, period_start) in (select period, period_start from touched);
${touched}
insert into ${schema}.period_percentiles (period, period_start, signal, p50, p95)
select touched.period, touched.period_start, signal, ${PERCENTILES}
from touched
join ${schema}.samples
  on samples.night >= touched.period_start
  and samples.night < touched.period_start + ('1 ' || touched.period)::interval
cross join lateral (values ${SIGNALS}) as signals (signal, value)
where value is not null
group by touched.period, touched.period_start, signal;
`;
}
