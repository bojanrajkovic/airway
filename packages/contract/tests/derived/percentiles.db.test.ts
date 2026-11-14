import { test } from "@airway/testing/postgres";
import { expect } from "vitest";
import { z } from "zod";
import { derivedTables } from "../../src/derived/ddl.ts";
import { periodPercentiles } from "../../src/derived/percentiles.ts";
import { withClient } from "../support/postgres.ts";

const Rows = z.array(
  z.object({
    period: z.string(),
    start: z.string(),
    signal: z.string(),
    p50: z.number(),
    p95: z.number(),
  }),
);

/** A night with one segment and the given leak samples, 2 s apart. */
const night = (date: string, leaks: readonly number[]): string => `
insert into derived.nights (night, sessions, expected_sessions, session_count_approximate,
  longest_stretch, obstructive_apneas, central_apneas, unclassified_apneas, hypopneas, arousals,
  events_outside_mask_on, ahi_check, rule_set, uploaded_at)
values ('${date}', 1, 1, false, 480, 0, 0, 0, 0, 0, 0, 'match', 'pediatric', '${date}T14:00Z');
insert into derived.files (path, kind, night, size, sha256, ctime)
values ('${date}/BRP.edf', 'brp', '${date}', 1024, 'abc', '${date}T14:00Z');
insert into derived.sessions (night, session, ts, ended_at, source)
values ('${date}', 1, '${date}T02:00Z', '${date}T10:00Z', 'str');
insert into derived.segments (night, segment, session, ts, ended_at, brp_path)
values ('${date}', 1, 1, '${date}T02:00Z', '${date}T10:00Z', '${date}/BRP.edf');
insert into derived.samples (night, segment, session, ts, leak)
values ${leaks.map((leak, i) => `('${date}', 1, 1, '${date}T02:00Z'::timestamptz + interval '${(2 * i).toString()} seconds', ${leak.toString()})`).join(", ")};`;

// 2030-01-28 is a Monday, so its week holds nights from January and February.
test("stores each week's and month's P50 and P95, as percentile_cont gives them", async ({
  databaseUrl,
}) => {
  const rows = await withClient(databaseUrl, async (client) => {
    await client.query(derivedTables("derived"));
    await client.query(night("2030-01-28", [0.2, 0.4]));
    await client.query(night("2030-02-01", [0.6, 0.8]));
    await client.query(periodPercentiles("derived"));
    const result = await client.query(
      `select period, period_start::text as start, signal,
         round(p50::numeric, 9)::float8 as p50, round(p95::numeric, 9)::float8 as p95
       from derived.period_percentiles order by period, period_start`,
    );

    return Rows.parse(result.rows);
  });

  // Rounded past float noise. Mask pressure has no samples, so it has no rows.
  expect(rows).toEqual([
    {
      period: "month",
      start: "2030-01-01",
      signal: "leak",
      p50: 0.3,
      p95: 0.39,
    },
    {
      period: "month",
      start: "2030-02-01",
      signal: "leak",
      p50: 0.7,
      p95: 0.79,
    },
    {
      period: "week",
      start: "2030-01-28",
      signal: "leak",
      p50: 0.5,
      p95: 0.77,
    },
  ]);
});
