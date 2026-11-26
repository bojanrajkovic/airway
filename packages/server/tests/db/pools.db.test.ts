// This file can start an OpenTelemetry SDK because the db project isolates each test file.
import { createRequire } from "node:module";
import { test } from "@airway/testing/postgres";
import { inMemoryTelemetry } from "@airway/testing/telemetry";
import { SpanKind } from "@opentelemetry/api";
import { pino } from "pino";
import { afterEach, beforeAll, describe, expect } from "vitest";
import { createPools, type Pools } from "../../src/db/pools.ts";
import { instrumentations } from "../../src/instrument.ts";

const { spans } = inMemoryTelemetry({ instrumentations: await instrumentations() });

// Requires pg after the helper's beforeAll starts the SDK, as the preload does.
// The instrumentation patches pg when pg is required after the SDK starts.
beforeAll(() => {
  createRequire(import.meta.url)("pg");
});

type Settings = { timeout: string; path: string };

let pools: Pools | undefined = undefined;

/** Clears the spans that creating the test's database recorded, then creates pools on it. */
function poolsFor(databaseUrl: string): Pools {
  spans.reset();
  pools = createPools({ databaseUrl }, pino({ level: "silent" }));

  return pools;
}

afterEach(async () => {
  await pools?.[Symbol.asyncDispose]();
  pools = undefined;
});

describe("createPools", () => {
  test("parses timestamptz as an Instant, date as a PlainDate, and int8 as a number", async ({
    databaseUrl,
  }) => {
    const { api } = poolsFor(databaseUrl);

    const { rows } = await api.query<{ at: unknown; night: unknown; total: unknown }>(
      "select timestamptz '2026-01-15 12:00:00.5+00' as at, date '2026-01-14' as night, count(*) as total from generate_series(1, 3)",
    );

    expect(rows[0]?.at).toEqual(Temporal.Instant.from("2026-01-15T12:00:00.5Z"));
    expect(rows[0]?.night).toEqual(Temporal.PlainDate.from("2026-01-14"));
    expect(rows[0]?.total).toBe(3);
  });

  test("rejects an int8 above 2^53 instead of rounding it", async ({ databaseUrl }) => {
    const { write } = poolsFor(databaseUrl);

    await expect(write.pool.query("select 9007199254740993::int8 as big")).rejects.toThrow(
      RangeError,
    );
  });

  test("sets statement_timeout and search_path on the query pools and leaves the write pool's defaults", async ({
    databaseUrl,
  }) => {
    const { write, api, agent } = poolsFor(databaseUrl);
    const settings = async (pool: Pools["api"]): Promise<Settings | undefined> =>
      (
        await pool.query<Settings>(
          "select current_setting('statement_timeout') as timeout, current_setting('search_path') as path",
        )
      ).rows[0];

    expect(await settings(api)).toEqual({ timeout: "10s", path: "derived" });
    expect(await settings(agent)).toEqual({ timeout: "15s", path: "derived" });
    const writes = await settings(write.pool);
    expect(writes?.timeout).toBe("0");
    expect(writes?.path).not.toBe("derived");
  });

  test("runs Drizzle on the write pool", async ({ databaseUrl }) => {
    const { write } = poolsFor(databaseUrl);

    const { rows } = await write.db.execute<{ one: number }>("select 1 as one");

    expect(rows).toEqual([{ one: 1 }]);
  });
});

describe("pg spans", () => {
  /**
   * Returns the SQL text of each query span that the test recorded. Skips pool connect spans,
   * which have no SQL text.
   */
  const recordedText = (): unknown[] =>
    spans
      .getFinishedSpans()
      .filter((span) => span.kind === SpanKind.CLIENT && "db.query.text" in span.attributes)
      .map((span) => span.attributes["db.query.text"]);

  test("record SQL with its literals replaced by placeholders", async ({ databaseUrl }) => {
    const { api } = poolsFor(databaseUrl);

    await api.query("select n from generate_series(1, 9) as n where n > 5 and 'secret' <> ''");

    expect(recordedText()).toEqual([
      "select n from generate_series($1, $2) as n where n > $3 and $4 <> $5",
    ]);
  });

  test("record parameterized SQL as written, without its values", async ({ databaseUrl }) => {
    const { api } = poolsFor(databaseUrl);

    await api.query("select $1::text as label", ["secret"]);

    expect(recordedText()).toEqual(["select $1::text as label"]);
    const text = spans
      .getFinishedSpans()
      .flatMap((span) => Object.values(span.attributes))
      .map(String)
      .join("\n");
    expect(text).not.toContain("secret");
  });

  test("record blank text for SQL that doesn't parse", async ({ databaseUrl }) => {
    const { api } = poolsFor(databaseUrl);

    await expect(api.query("select 'secret' from")).rejects.toThrow();

    expect(recordedText()).toEqual([""]);
  });
});
