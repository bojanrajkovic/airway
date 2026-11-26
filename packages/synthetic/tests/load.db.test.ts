import pg from "pg";
import { expect } from "vitest";
import { z } from "zod";
import { test } from "@airway/testing/postgres";
import { loadDerived } from "../src/load.ts";
import { syntheticNights, type SyntheticNight } from "../src/model.ts";
import { Patient } from "../src/patients.ts";
import { synthesize } from "../src/synthesize.ts";

const zone = "America/New_York";
const arrivedAt = Temporal.Instant.from("2030-03-01T12:00:00Z");

async function withClient<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(url);
  await client.connect();

  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function load(
  url: string,
  nights: readonly SyntheticNight[],
  schema: "derived" | "derived_next",
): Promise<void> {
  const { rows } = synthesize(nights, zone, { patient: Patient.Child, arrivedAt })._unsafeUnwrap();

  await withClient(url, async (client) => {
    // The file's tests share one database, so each load replaces the schema.
    await client.query(`drop schema if exists ${schema} cascade`);
    await loadDerived(client, rows, { schema, builtAt: arrivedAt });
  });
}

const NightCounts = z.array(
  z.object({ night: z.string(), ahi: z.number(), samples: z.coerce.number() }),
);
const Count = z.array(z.object({ count: z.coerce.number() }));

test(
  "for each of 30 nights, loads one row with the machine's AHI and all of the night's 2 s samples",
  // Building and loading 30 nights can take longer than Vitest's default timeout.
  { timeout: 30_000 },
  async ({ databaseUrl }) => {
    const { nights } = syntheticNights({ seed: 7, nights: 30 })._unsafeUnwrap();

    await load(databaseUrl, nights, "derived");

    const rows = await withClient(databaseUrl, async (client) => {
      const result = await client.query(
        `select n.night::text as night, n.ahi,
                (select count(*) from derived.samples s where s.night = n.night) as samples
         from derived.nights n order by n.night`,
      );

      return NightCounts.parse(result.rows);
    });

    expect(rows).toEqual(
      nights.map((night) => ({
        night: night.night.toString(),
        ahi: night.str["AHI"],
        samples:
          night.segments.reduce(
            (sum, { start, end }) => sum + start.until(end).total("seconds"),
            0,
          ) / 2,
      })),
    );

    const stamped = await withClient(databaseUrl, async (client) => ({
      meta: Count.parse((await client.query("select count(*) from derived.meta")).rows),
      percentiles: Count.parse(
        (await client.query("select count(*) from derived.period_percentiles")).rows,
      ),
    }));

    expect(stamped.meta).toEqual([{ count: 1 }]);
    expect(stamped.percentiles[0]?.count).toBeGreaterThan(0);
  },
);

test("loads only a daily_usage row for a night with no segments", async ({ databaseUrl }) => {
  const [first, second, third] = syntheticNights({ seed: 7, nights: 3 })._unsafeUnwrap().nights;

  if (first === undefined || second === undefined || third === undefined) {
    throw new Error("expected three nights");
  }

  await load(
    databaseUrl,
    [first, { ...second, segments: [], eventFiles: [] }, third],
    "derived_next",
  );

  const counts = await withClient(databaseUrl, async (client) => {
    const count = async (sql: string): Promise<number> =>
      Count.parse((await client.query(sql, [second.night.toString()])).rows)[0]?.count ?? -1;

    return {
      usage: await count("select count(*) from derived_next.daily_usage where day = $1"),
      segments: await count("select count(*) from derived_next.segments where night = $1"),
    };
  });

  expect(counts).toEqual({ usage: 1, segments: 0 });
});

test("grants the reader SELECT on the loaded schema", async ({ databaseUrl, readerUrl }) => {
  const { nights } = syntheticNights({ seed: 7, nights: 1 })._unsafeUnwrap();

  await load(databaseUrl, nights, "derived");

  const count = await withClient(readerUrl, async (client) =>
    Count.parse((await client.query("select count(*) from derived.nights")).rows),
  );

  expect(count).toEqual([{ count: 1 }]);
});
