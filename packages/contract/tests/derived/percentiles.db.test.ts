import { test, withClient } from "@airway/testing/postgres";
import { expect } from "vitest";
import { z } from "zod";
import { derivedTables } from "../../src/derived/ddl.ts";
import {
  rebuildAllPercentiles,
  recomputePeriodPercentiles,
} from "../../src/derived/percentiles.ts";

const Rows = z.array(
  z.object({
    period: z.string(),
    start: z.string(),
    signal: z.string(),
    p50: z.number(),
    p95: z.number(),
  }),
);

/** Returns SQL that inserts a night with one segment and a leak sample every 2 s. */
const night = (date: string, leaks: readonly number[]): string => `
insert into derived.nights (night, sessions, expected_sessions, session_count_approximate,
  longest_stretch, obstructive_apneas, central_apneas, unclassified_apneas, hypopneas, arousals,
  events_outside_mask_on, ahi_check, rule_set, possibly_corrupted, arrived_at)
values ('${date}', 1, 1, false, 480, 0, 0, 0, 0, 0, 0, 'match', 'pediatric', false, '${date}T14:00Z');
insert into derived.sessions (night, session, ts, ended_at, source)
values ('${date}', 1, '${date}T02:00Z', '${date}T10:00Z', 'str');
insert into derived.segments (night, segment, session, ts, ended_at)
values ('${date}', 1, 1, '${date}T02:00Z', '${date}T10:00Z');
insert into derived.files (path, kind, night, segment, size, sha256, ctime, checksum, bad_records)
values ('${date}/BRP.edf', 'brp', '${date}', 1, 1024, 'abc', '${date}T14:00Z', 'match', 0);
insert into derived.samples (night, segment, session, ts, leak)
values ${leaks.map((leak, i) => `('${date}', 1, 1, '${date}T02:00Z'::timestamptz + interval '${(2 * i).toString()} seconds', ${leak.toString()})`).join(", ")};`;

// The tests in this file share one database, so each test drops and recreates the `derived` schema.
const FRESH = `drop schema if exists derived cascade; ${derivedTables("derived")}`;

// The week of Monday 2030-01-28 ends in February, so it includes both nights.
test("stores the P50 and P95 that percentile_cont computes for each week and month", async ({
  databaseUrl,
}) => {
  const rows = await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);
    await client.query(night("2030-01-28", [0.2, 0.4]));
    await client.query(night("2030-02-01", [0.6, 0.8]));
    await client.query(rebuildAllPercentiles("derived"));
    const result = await client.query(
      `select period, period_start::text as start, signal,
         round(p50::numeric, 9)::float8 as p50, round(p95::numeric, 9)::float8 as p95
       from derived.period_percentiles order by period, period_start`,
    );

    return Rows.parse(result.rows);
  });

  // The query rounds each percentile to 9 decimal places to remove float noise.
  // The test inserts only leak samples, so every row's signal is `leak`.
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

const ALL_ROWS = `select period, period_start::text as start, signal,
  round(p50::numeric, 9)::float8 as p50, round(p95::numeric, 9)::float8 as p95
from derived.period_percentiles order by period, period_start, signal`;

test("recomputes only the weeks and months that contain the given nights", async ({
  databaseUrl,
}) => {
  const { before, after, full } = await withClient(databaseUrl, async (client) => {
    const rows = async (): Promise<z.infer<typeof Rows>> =>
      Rows.parse((await client.query(ALL_ROWS)).rows);

    await client.query(FRESH);
    await client.query(night("2030-01-28", [0.2, 0.4]));
    await client.query(night("2030-02-01", [0.6, 0.8]));
    await client.query(night("2030-03-11", [1.0, 1.2]));
    await client.query(rebuildAllPercentiles("derived"));
    const filled = await rows();

    // The update changes every night's samples, but the call recomputes only the periods that
    // contain 2030-02-01, which are the week of Monday 2030-01-28 and February.
    await client.query("update derived.samples set leak = leak + 1");
    await client.query(
      recomputePeriodPercentiles("derived", [Temporal.PlainDate.from("2030-02-01")]),
    );
    const recomputed = await rows();

    await client.query("truncate derived.period_percentiles");
    await client.query(rebuildAllPercentiles("derived"));

    return { before: filled, after: recomputed, full: await rows() };
  });
  const touched = ({ period, start }: { period: string; start: string }): boolean =>
    (period === "week" && start === "2030-01-28") || (period === "month" && start === "2030-02-01");

  expect(after.filter(touched)).toEqual(full.filter(touched));
  expect(after.filter((row) => !touched(row))).toEqual(before.filter((row) => !touched(row)));
  expect(after.filter(touched)).not.toEqual(before.filter(touched));
});

test("deletes a period's rows when its samples are deleted", async ({ databaseUrl }) => {
  const rows = await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);
    await client.query(night("2030-01-28", [0.2, 0.4]));
    await client.query(night("2030-03-11", [1.0, 1.2]));
    await client.query(rebuildAllPercentiles("derived"));
    await client.query(`delete from derived.samples where night = '2030-03-11'`);
    await client.query(
      recomputePeriodPercentiles("derived", [Temporal.PlainDate.from("2030-03-11")]),
    );

    return Rows.parse((await client.query(ALL_ROWS)).rows);
  });

  expect(rows.map(({ period, start }) => `${period} ${start}`)).toEqual([
    "month 2030-01-01",
    "week 2030-01-28",
  ]);
});
