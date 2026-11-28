import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ResultAsync } from "neverthrow";
import pg from "pg";
import { expect, onTestFinished } from "vitest";
import { z } from "zod";
import { derivedIndexesAndKeys, derivedTables } from "@airway/contract/derived/ddl";
import { test, withClient } from "@airway/testing/postgres";
import { importFolder } from "../../src/ingest/import.ts";
import { ImportMetrics } from "../../src/ingest/metrics.ts";
import type { SeenFile } from "../../src/ingest/readiness.ts";
import type { ScannedFile } from "../../src/ingest/scan.ts";
import type { FileVersion } from "../../src/ingest/versions.ts";
import { importContext, syntheticFolder } from "../support/cpap-folder.ts";

// The tests in this file share one database, so each test drops and recreates the `derived` schema.
const FRESH = `drop schema if exists derived cascade; ${derivedTables("derived")} ${derivedIndexesAndKeys("derived")}`;

/** Returns a pool for the test's database that closes when the test finishes. */
function poolFor(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  onTestFinished(async () => {
    await pool.end();
  });

  return pool;
}

const byCtime = (file: ScannedFile): Temporal.Instant => file.ctime;
const metrics = new ImportMetrics();

const Version = z.object({ path: z.string(), size: z.coerce.number(), sha256: z.string() });

async function importedVersions(client: pg.ClientBase): Promise<FileVersion[]> {
  return z
    .array(Version)
    .parse((await client.query("select path, size, sha256 from derived.files")).rows);
}

async function count(client: pg.ClientBase, table: string): Promise<number> {
  const { rows } = await client.query(`select count(*)::int as n from derived.${table}`);

  return z.object({ n: z.number() }).parse(rows[0]).n;
}

test("imports every night, the STR.edf tables, and the period percentiles", async ({
  databaseUrl,
}) => {
  const ctx = await importContext(syntheticFolder(3));

  const { summary, nights, percentiles, usage } = await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);
    const summary = (
      await importFolder(
        ctx,
        { client, pool: poolFor(databaseUrl), schema: "derived" },
        { imported: [], seen: new Map(), since: byCtime },
        metrics,
      )
    )._unsafeUnwrap();

    return {
      summary,
      nights: await count(client, "nights"),
      percentiles: await count(client, "period_percentiles"),
      usage: await count(client, "daily_usage"),
    };
  });

  expect(summary).toEqual({ planned: 3, committed: 3, failed: [], nightsBeforeStr: 0 });
  expect(nights).toBe(3);
  expect(percentiles).toBeGreaterThan(0);
  expect(usage).toBeGreaterThan(0);
});

test("lists a night that fails in `failed` and commits the other nights", async ({
  databaseUrl,
}) => {
  const asked: Temporal.PlainDate[] = [];
  const ctx = await importContext(syntheticFolder(3), (night) => asked.push(night) === 2);

  const { summary, imported } = await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);
    const summary = (
      await importFolder(
        ctx,
        { client, pool: poolFor(databaseUrl), schema: "derived" },
        { imported: [], seen: new Map(), since: byCtime },
        metrics,
      )
    )._unsafeUnwrap();
    const { rows } = await client.query(
      "select count(*)::int as n from derived.files where night = $1",
      [asked[1]?.toString()],
    );

    return { summary, imported: z.object({ n: z.number() }).parse(rows[0]).n };
  });

  expect(summary).toMatchObject({ planned: 3, committed: 2 });
  expect(summary.failed).toEqual([asked[1]]);
  expect(imported).toBe(0);
});

test("imports nothing and returns a null STR.edf count while STR.edf isn't ready", async ({
  databaseUrl,
}) => {
  const ctx = await importContext(syntheticFolder(2));
  const now = ctx.clock();

  const summary = await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);

    // A poll's first look at a file makes it wait 2 minutes.
    return (
      await importFolder(
        ctx,
        { client, pool: poolFor(databaseUrl), schema: "derived" },
        { imported: [], seen: new Map(), since: () => now },
        metrics,
      )
    )._unsafeUnwrap();
  });

  expect(summary).toEqual({ planned: 0, committed: 0, failed: [], nightsBeforeStr: null });
});

test("plans zero nights on a second pass that reads `imported` from the files table", async ({
  databaseUrl,
}) => {
  const ctx = await importContext(syntheticFolder(2));
  const seen = new Map<string, SeenFile>();

  const second = await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);
    (
      await importFolder(
        ctx,
        { client, pool: poolFor(databaseUrl), schema: "derived" },
        { imported: [], seen: seen, since: byCtime },
        metrics,
      )
    )._unsafeUnwrap();

    return (
      await importFolder(
        ctx,
        { client, pool: poolFor(databaseUrl), schema: "derived" },
        { imported: await importedVersions(client), seen: seen, since: byCtime },
        metrics,
      )
    )._unsafeUnwrap();
  });

  expect(second).toEqual({ planned: 0, committed: 0, failed: [], nightsBeforeStr: 0 });
});

test("deletes a pass's files rows when the percentile recompute fails, so the next pass imports those nights again", async ({
  databaseUrl,
}) => {
  const ctx = await importContext(syntheticFolder(2));

  const { error, files, second } = await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);
    await client.query("alter table derived.period_percentiles rename to hidden");
    const first = await importFolder(
      ctx,
      { client, pool: poolFor(databaseUrl), schema: "derived" },
      { imported: [], seen: new Map(), since: byCtime },
      metrics,
    );
    const files = await client.query("select 1 from derived.files where night is not null");
    await client.query("alter table derived.hidden rename to period_percentiles");

    return {
      error: first._unsafeUnwrapErr(),
      files: files.rowCount,
      second: (
        await importFolder(
          ctx,
          { client, pool: poolFor(databaseUrl), schema: "derived" },
          { imported: await importedVersions(client), seen: new Map(), since: byCtime },
          metrics,
        )
      )._unsafeUnwrap(),
    };
  });

  expect(error.kind).toBe("write_failed");
  expect(files).toBe(0);
  expect(second).toMatchObject({ planned: 2, committed: 2 });
});

test("skips the STR.edf tables while Identification.tgt is missing, and writes them on a later pass", async ({
  databaseUrl,
}) => {
  const ctx = await importContext(syntheticFolder(2));
  const root = ctx.config.cpapDataPath;
  const identification = await readFile(join(root, "Identification.tgt"));
  await rm(join(root, "Identification.tgt"));

  const { before, after } = await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);
    (
      await importFolder(
        ctx,
        { client, pool: poolFor(databaseUrl), schema: "derived" },
        { imported: [], seen: new Map(), since: byCtime },
        metrics,
      )
    )._unsafeUnwrap();
    const before = await count(client, "daily_usage");
    await writeFile(join(root, "Identification.tgt"), identification);
    (
      await importFolder(
        ctx,
        { client, pool: poolFor(databaseUrl), schema: "derived" },
        { imported: await importedVersions(client), seen: new Map(), since: byCtime },
        metrics,
      )
    )._unsafeUnwrap();

    return { before, after: await count(client, "daily_usage") };
  });

  expect(before).toBe(0);
  expect(after).toBeGreaterThan(0);
});

test("writes the nights on two connections from the pool", async ({ databaseUrl }) => {
  const ctx = await importContext(syntheticFolder(4));
  const pool = poolFor(databaseUrl);
  let acquired = 0;
  pool.on("acquire", () => {
    acquired += 1;
  });

  const summary = await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);

    return (
      await importFolder(
        ctx,
        { client, pool, schema: "derived" },
        { imported: [], seen: new Map(), since: byCtime },
        metrics,
      )
    )._unsafeUnwrap();
  });

  expect(summary).toMatchObject({ planned: 4, committed: 4, failed: [] });
  expect(acquired).toBe(2);
});

test("keeps at most two nights per worker computing or waiting for a write", async ({
  databaseUrl,
}) => {
  const base = await importContext(syntheticFolder(5));
  // testContext sets one worker, so the window is 2 nights.
  const window = base.config.ingestWorkers * 2;
  const counter = new pg.Client(databaseUrl);
  await counter.connect();
  onTestFinished(async () => {
    await counter.end();
  });
  const committedAtStart: number[] = [];
  const ctx = {
    ...base,
    nightPool: {
      ...base.nightPool,
      run: (task: Parameters<typeof base.nightPool.run>[0]) => {
        committedAtStart.push(-1);
        const slot = committedAtStart.length - 1;

        return ResultAsync.fromSafePromise(
          count(counter, "nights").then((n) => {
            committedAtStart[slot] = n;
          }),
        ).andThen(() => base.nightPool.run(task));
      },
    },
  };

  await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);
    (
      await importFolder(
        ctx,
        { client, pool: poolFor(databaseUrl), schema: "derived" },
        { imported: [], seen: new Map(), since: byCtime },
        metrics,
      )
    )._unsafeUnwrap();
  });

  expect(committedAtStart).toHaveLength(5);
  // When night k starts, the other write connection may still be writing one more night.
  committedAtStart.forEach((committed, k) => {
    expect(committed, `night ${String(k)}`).toBeGreaterThanOrEqual(k - window - 1);
  });
});
