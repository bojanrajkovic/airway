// Starts an OpenTelemetry SDK, which is safe here: the db project isolates each file.
import { createRequire } from "node:module";
import { test } from "@airway/testing/postgres";
import { inMemoryTelemetry } from "@airway/testing/telemetry";
import { SpanKind } from "@opentelemetry/api";
import { pino } from "pino";
import { afterEach, beforeAll, describe, expect } from "vitest";
import { createPools, type Pools } from "../../src/db/pools.ts";
import { instrumentations } from "../../src/instrument.ts";

const { spans } = inMemoryTelemetry({ instrumentations: await instrumentations() });

// Runs after the helper's beforeAll starts the SDK. As the preload does: the instrumentation
// patches pg when it's required after the start.
beforeAll(() => {
  createRequire(import.meta.url)("pg");
});

let pools: Pools | undefined = undefined;

/**
 * Pools on the test's database, closed after the test. Both reader pools use the same URL here.
 * Clears the spans the database fixture recorded while creating the database.
 */
function poolsFor(databaseUrl: string): Pools {
  spans.reset();
  pools = createPools({ databaseUrl, readerDatabaseUrl: databaseUrl }, pino({ level: "silent" }));

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
    const { owner } = poolsFor(databaseUrl);

    await expect(owner.pool.query("select 9007199254740993::int8 as big")).rejects.toThrow(
      RangeError,
    );
  });

  test("gives each reader pool its own statement_timeout, and the owner none", async ({
    databaseUrl,
  }) => {
    const { owner, api, agent } = poolsFor(databaseUrl);
    const timeout = async (pool: Pools["api"]): Promise<unknown> =>
      (await pool.query<{ statement_timeout: string }>("show statement_timeout")).rows[0]
        ?.statement_timeout;

    expect(await timeout(api)).toBe("10s");
    expect(await timeout(agent)).toBe("15s");
    expect(await timeout(owner.pool)).toBe("0");
  });

  test("runs Drizzle on the owner pool", async ({ databaseUrl }) => {
    const { owner } = poolsFor(databaseUrl);

    const { rows } = await owner.db.execute<{ one: number }>("select 1 as one");

    expect(rows).toEqual([{ one: 1 }]);
  });
});

describe("pg spans", () => {
  /** The SQL text on every query span the test recorded. Pool connect spans carry none. */
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
