import type pg from "pg";
import { expect } from "vitest";
import { z } from "zod";
import { derivedIndexesAndKeys, derivedTables } from "@airway/contract/derived/ddl";
import { EdgeCaseName } from "@airway/synthetic/cases";
import { test, withClient } from "@airway/testing/postgres";
import { computeNight } from "../../src/ingest/night.ts";
import type { NightFiles } from "../../src/ingest/segments.ts";
import { writeNight, type ComputedNight } from "../../src/ingest/write.ts";
import {
  folderContext,
  nightTasks,
  synthesizedNights,
  writeFolder,
} from "../support/cpap-folder.ts";

// The tests in this file share one database, so each test drops and recreates the `derived` schema.
const FRESH = `drop schema if exists derived cascade; ${derivedTables("derived")} ${derivedIndexesAndKeys("derived")}`;

const synthetic = synthesizedNights(
  [EdgeCaseName.DamagedFiles, EdgeCaseName.SplitFiles, EdgeCaseName.ManyPeriods],
  1,
);

/** Computes every night of the synthetic folder. */
async function computed(): Promise<ComputedNight[]> {
  const folder = folderContext(await writeFolder(synthetic.files));

  return await Promise.all(
    nightTasks(synthetic).map(async (task) => ({
      task,
      result: (await computeNight(folder, task))._unsafeUnwrap(),
    })),
  );
}

const Json = z.array(z.object({ row: z.record(z.string(), z.unknown()) }));

/**
 * Reads `table`'s rows as JSON, converts each timestamp to Temporal's string form, and drops the
 * columns listed in `skip`.
 */
async function tableRows(
  client: pg.ClientBase,
  table: string,
  skip: readonly string[] = [],
): Promise<Record<string, unknown>[]> {
  const { rows } = await client.query(`select to_jsonb(t) as row from derived.${table} t`);

  return Json.parse(rows).map(({ row }) =>
    Object.fromEntries(
      Object.entries(row)
        .filter(([column]) => !skip.includes(column))
        .map(([column, value]) => [
          column,
          typeof value === "string" && /T\d\d:/v.test(value)
            ? Temporal.Instant.from(value).toString()
            : value,
        ]),
    ),
  );
}

/** Returns `rows` as JSON-like objects, flattens `signals`, and drops the columns listed in `skip`. */
const expected = (
  rows: readonly object[],
  skip: readonly string[] = [],
): Record<string, unknown>[] =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row)
        .flatMap(([column, value]: [string, unknown]): [string, unknown][] =>
          column === "signals" && typeof value === "object" && value !== null
            ? Object.entries(value)
            : [[column, value]],
        )
        .filter(([column]) => !skip.includes(column))
        .map(([column, value]) => [
          column,
          value instanceof Temporal.Instant || value instanceof Temporal.PlainDate
            ? value.toString()
            : value,
        ]),
    ),
  );

// Sorts rows by their JSON with the keys in order, because Postgres and the expected rows list the
// columns in different orders.
const keyOf = (row: Record<string, unknown>): string =>
  JSON.stringify(Object.entries(row).toSorted(([a], [b]) => a.localeCompare(b)));
const sorted = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
  rows.toSorted((a, b) => keyOf(a).localeCompare(keyOf(b)));

const Scalar = z.tuple([z.object({ v: z.string() })]);

/** Runs `sql`, which must select one row with one text column named `v`, and returns that value. */
const scalar = async (client: pg.ClientBase, sql: string): Promise<string> =>
  Scalar.parse((await client.query(sql)).rows)[0].v;

const count = async (client: pg.ClientBase, table: string): Promise<number> =>
  Number(await scalar(client, `select count(*)::text as v from derived.${table}`));

test("writes the rows that synthesize expects for each night", async ({ databaseUrl }) => {
  const nights = await computed();
  const nightKeys = new Set(nights.map(({ task }) => task.night.toString()));
  const ofNights = <T extends { night: Temporal.PlainDate | null }>(rows: readonly T[]): T[] =>
    rows.filter(({ night }) => night !== null && nightKeys.has(night.toString()));

  await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);

    for (const night of nights) {
      (await writeNight(client, "derived", night))._unsafeUnwrap();
    }

    expect(sorted(await tableRows(client, "nights", ["arrived_at"]))).toEqual(
      sorted(expected(ofNights(synthetic.rows.nights), ["arrived_at"])),
    );

    expect(sorted(await tableRows(client, "sessions"))).toEqual(
      sorted(expected(ofNights(synthetic.rows.sessions))),
    );
    expect(sorted(await tableRows(client, "segments"))).toEqual(
      sorted(expected(ofNights(synthetic.rows.segments))),
    );
    expect(sorted(await tableRows(client, "events"))).toEqual(
      sorted(expected(ofNights(synthetic.rows.events))),
    );
    expect(sorted(await tableRows(client, "files", ["ctime"]))).toEqual(
      sorted(expected(ofNights(synthetic.rows.files), ["ctime"])),
    );
    expect(await count(client, "samples")).toBe(ofNights(synthetic.rows.samples).length);
    expect(await count(client, "breaths")).toBe(
      nights.reduce(
        (sum, { result }) => sum + result.breaths.reduce((n, { ts }) => n + ts.length, 0),
        0,
      ),
    );
  });
});

test("stores sample values that match their decimal literal", async ({ databaseUrl }) => {
  const [night] = await computed();
  const leak = night?.result.samples[0]?.signals.leak.find(
    (value) => value > 0 && !Number.isInteger(value),
  );

  if (night === undefined || leak === undefined) {
    throw new Error("expected a night with a fractional leak sample");
  }

  await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);
    (await writeNight(client, "derived", night))._unsafeUnwrap();

    const matches = Number(
      await scalar(
        client,
        `select count(*)::text as v from derived.samples where leak = ${String(leak)}`,
      ),
    );

    expect(matches).toBeGreaterThan(0);
  });
});

test("replaces a night's rows, and keeps them when a write fails", async ({ databaseUrl }) => {
  const [night] = await computed();

  if (night === undefined) {
    throw new Error("expected a night");
  }

  const broken: ComputedNight = {
    ...night,
    result: {
      ...night.result,
      breaths: night.result.breaths.map((block) => ({ ...block, segment: 99 })),
    },
  };

  await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);
    (await writeNight(client, "derived", night))._unsafeUnwrap();
    (await writeNight(client, "derived", night))._unsafeUnwrap();
    const before = {
      samples: await count(client, "samples"),
      breaths: await count(client, "breaths"),
    };

    expect((await writeNight(client, "derived", broken))._unsafeUnwrapErr().kind).toBe(
      "write_failed",
    );
    expect({
      samples: await count(client, "samples"),
      breaths: await count(client, "breaths"),
    }).toEqual(before);
    expect(before.samples).toBeGreaterThan(0);
  });
});

test("keeps arrived_at for unchanged files and moves it forward when one changes", async ({
  databaseUrl,
}) => {
  const [night] = await computed();
  const [first] = night?.task.files ?? [];

  if (night === undefined || first === undefined) {
    throw new Error("expected a night with a BRP or PLD file");
  }

  const later = first.ctime.add({ hours: 1 });
  const touched: NightFiles = {
    ...night.task,
    files: night.task.files.map((file) => (file === first ? { ...file, ctime: later } : file)),
  };
  const arrived = async (client: pg.ClientBase): Promise<Temporal.Instant> =>
    Temporal.Instant.from(
      await scalar(client, "select to_jsonb(arrived_at) #>> '{}' as v from derived.nights"),
    );

  await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);
    (await writeNight(client, "derived", night))._unsafeUnwrap();
    const once = await arrived(client);

    (await writeNight(client, "derived", night))._unsafeUnwrap();
    const twice = await arrived(client);

    (await writeNight(client, "derived", { ...night, task: touched }))._unsafeUnwrap();

    expect(twice).toEqual(once);
    expect(await arrived(client)).toEqual(later);
  });
});

test("replaces a night's samples and breaths in a schema that has no keys yet", async ({
  databaseUrl,
}) => {
  const [night] = await computed();

  if (night === undefined) {
    throw new Error("expected a night");
  }

  await withClient(databaseUrl, async (client) => {
    // A rebuild may fill its tables before derivedIndexesAndKeys adds the samples and breaths keys.
    await client.query(`drop schema if exists derived cascade; ${derivedTables("derived")}`);
    (await writeNight(client, "derived", night))._unsafeUnwrap();
    const once = {
      samples: await count(client, "samples"),
      breaths: await count(client, "breaths"),
    };

    (await writeNight(client, "derived", night))._unsafeUnwrap();

    expect({
      samples: await count(client, "samples"),
      breaths: await count(client, "breaths"),
    }).toEqual(once);
  });
});
