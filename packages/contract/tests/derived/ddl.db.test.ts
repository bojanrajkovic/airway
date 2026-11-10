import { test } from "@airway/testing/postgres";
import { expect } from "vitest";
import { z } from "zod";
import { derivedDdl } from "../../src/derived/ddl.ts";
import { withClient } from "../support/postgres.ts";

const NIGHT_TABLES = ["files", "sessions", "segments", "events", "samples", "breaths"] as const;
const Tables = z.array(z.object({ name: z.string(), persistence: z.string() }));
const Counts = z.array(
  z.object({ name: z.string(), night: z.string().nullable(), rows: z.number() }),
);

/** One night with a row in every table that holds a night's rows. */
const nightRows = (night: string): string => `
insert into derived.nights (night, sessions, expected_sessions, session_count_approximate,
  longest_stretch, obstructive_apneas, central_apneas, unclassified_apneas, hypopneas, arousals,
  events_outside_mask_on, ahi_check, rule_set, uploaded_at)
values ('${night}', 1, 1, false, 480, 1, 0, 0, 0, 0, 0, 'match', 'pediatric', '${night}T14:00Z');
insert into derived.files (path, kind, night, size, sha256, ctime)
values ('DATALOG/${night}/BRP.edf', 'brp', '${night}', 1024, 'abc', '${night}T14:00Z');
insert into derived.sessions (night, session, ts, ended_at, source)
values ('${night}', 1, '${night}T02:00Z', '${night}T10:00Z', 'str');
insert into derived.segments (night, segment, session, ts, ended_at, brp_path)
values ('${night}', 1, 1, '${night}T02:00Z', '${night}T10:00Z', 'DATALOG/${night}/BRP.edf');
insert into derived.events (night, session, ts, duration, type, source, outside_mask_on)
values ('${night}', 1, '${night}T03:00Z', 12, 'obstructive_apnea', 'resmed', false),
       ('${night}', null, '${night}T11:00Z', 10, 'hypopnea', 'resmed', true);
insert into derived.samples (night, segment, session, ts, leak)
values ('${night}', 1, 1, '${night}T02:00Z', 0.4);
insert into derived.breaths (night, segment, session, ts, duration, amplitude, inspiratory_volume)
values ('${night}', 1, 1, '${night}T02:00Z', 3.2, 0.3, 0.25);`;

const countsByNight = NIGHT_TABLES.map(
  (table) =>
    `select '${table}' as name, night::text as night, count(*)::int as rows from derived.${table} group by night`,
).join(" union all ");

test("creates every table UNLOGGED, in derived_next", async ({ databaseUrl }) => {
  const tables = await withClient(databaseUrl, async (client) => {
    await client.query(derivedDdl("derived_next"));
    const result = await client.query(
      `select relname as name, relpersistence as persistence from pg_class
       where relnamespace = 'derived_next'::regnamespace and relkind = 'r' order by relname`,
    );

    return Tables.parse(result.rows);
  });

  expect(tables.map(({ name }) => name)).toEqual([
    "breaths",
    "column_units",
    "daily_usage",
    "device",
    "events",
    "files",
    "meta",
    "nights",
    "period_percentiles",
    "samples",
    "segments",
    "sessions",
    "settings_changes",
  ]);
  expect(tables.filter(({ persistence }) => persistence !== "u")).toEqual([]);
});

test("deleting a night removes its rows from every table, and no other night's", async ({
  databaseUrl,
}) => {
  const counts = await withClient(databaseUrl, async (client) => {
    await client.query(derivedDdl("derived"));
    await client.query(nightRows("2030-01-01") + nightRows("2030-01-02"));
    await client.query(
      `insert into derived.files (path, kind, size, sha256, ctime)
       values ('STR.edf', 'str', 2048, 'def', '2030-01-02T14:00Z')`,
    );
    // Segment 1 belongs to session 1, so a sample can't put it in session 2.
    await expect(
      client.query(
        `insert into derived.samples (night, segment, session, ts) values ('2030-01-01', 1, 2, now())`,
      ),
    ).rejects.toThrow(/foreign key/v);

    // A file a segment was read from can't go while the segment stays.
    await expect(
      client.query(`delete from derived.files where path = 'DATALOG/2030-01-01/BRP.edf'`),
    ).rejects.toThrow(/foreign key/v);

    await client.query(`delete from derived.nights where night = '2030-01-01'`);
    const result = await client.query(`${countsByNight} order by name, night`);

    return Counts.parse(result.rows);
  });

  expect(counts).toEqual([
    { name: "breaths", night: "2030-01-02", rows: 1 },
    { name: "events", night: "2030-01-02", rows: 2 },
    { name: "files", night: "2030-01-02", rows: 1 },
    // STR.edf belongs to no night, so no night's delete removes it.
    { name: "files", night: null, rows: 1 },
    { name: "samples", night: "2030-01-02", rows: 1 },
    { name: "segments", night: "2030-01-02", rows: 1 },
    { name: "sessions", night: "2030-01-02", rows: 1 },
  ]);
});
