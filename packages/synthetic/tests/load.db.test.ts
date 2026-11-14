import pg from "pg";
import { expect } from "vitest";
import { z } from "zod";
import { ClockOffsets } from "@airway/contract/clock";
import { test } from "@airway/testing/postgres";
import { loadDerived } from "../src/load.ts";
import { syntheticNights, type SyntheticNight } from "../src/model.ts";
import { synthesize } from "../src/synthesize.ts";

const offsets = ClockOffsets.parse([{ from: "2030-01-01", utcOffset: "-05:00" }]);
const uploadedAt = Temporal.Instant.from("2030-03-01T12:00:00Z");

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
  const { rows } = synthesize(nights, offsets, { patient: "child", uploadedAt })._unsafeUnwrap();

  await withClient(url, async (client) => {
    await loadDerived(client, rows, { schema, builtAt: uploadedAt });
  });
}

const NightCounts = z.array(
  z.object({ night: z.string(), ahi: z.number(), samples: z.coerce.number() }),
);
const Count = z.array(z.object({ count: z.coerce.number() }));

test(
  "loads a month: one night row per night with the machine's AHI, and every 2 s sample",
  { timeout: 60_000 },
  async ({ databaseUrl }) => {
    const nights = syntheticNights({ seed: 7, nights: 30 });

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
        ahi: night.str.get("AHI"),
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

test(
  "keeps only daily usage for a night with no segments, and lets the reader read but not write",
  { timeout: 30_000 },
  async ({ databaseUrl, readerUrl }) => {
    const [first, second, third] = syntheticNights({ seed: 7, nights: 3 });

    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("expected three nights");
    }

    await load(databaseUrl, [first, { ...second, segments: [] }, third], "derived_next");

    const counts = await withClient(databaseUrl, async (client) => {
      const count = async (sql: string): Promise<number> =>
        Count.parse((await client.query(sql, [second.night.toString()])).rows)[0]?.count ?? -1;

      return {
        usage: await count("select count(*) from derived_next.daily_usage where day = $1"),
        segments: await count("select count(*) from derived_next.segments where night = $1"),
      };
    });

    expect(counts).toEqual({ usage: 1, segments: 0 });

    // A table the reader was never granted.
    await withClient(databaseUrl, async (client) => {
      await client.query("create schema other; create table other.secrets (value text)");
    });

    await withClient(readerUrl, async (client) => {
      const nights = Count.parse(
        (await client.query("select count(*) from derived_next.nights")).rows,
      );

      expect(nights).toEqual([{ count: 2 }]);
      await expect(client.query("delete from derived_next.nights")).rejects.toThrow(
        /read-only transaction/v,
      );
      await expect(client.query("select * from other.secrets")).rejects.toThrow(
        /permission denied/v,
      );
    });
  },
);
