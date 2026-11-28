import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { expect, onTestFinished } from "vitest";
import { z } from "zod";
import { DERIVED_VERSION } from "@airway/contract/derived/ddl";
import { edgeCaseNames } from "@airway/synthetic/cases";
import { test } from "@airway/testing/postgres";
import { rebuild } from "../../src/ingest/rebuild.ts";
import type { AppContext } from "../../src/runtime/context.ts";
import { importContext, synthesizedNights, syntheticFolder } from "../support/cpap-folder.ts";

const lockTimeout = Temporal.Duration.from({ seconds: 1 });

/** Returns a pool for the test's database with no derived schemas left from an earlier test. */
async function cleanPool(databaseUrl: string): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  onTestFinished(async () => {
    await pool.end();
  });
  await pool.query(
    "drop schema if exists derived cascade; drop schema if exists derived_next cascade; drop schema if exists derived_old cascade",
  );

  return pool;
}

const run = (
  ctx: AppContext,
  pool: pg.Pool,
  allowDroppedNights = false,
): ReturnType<typeof rebuild> => rebuild(ctx, pool, { allowDroppedNights, lockTimeout });

async function count(pool: pg.Pool | pg.Client, table: string): Promise<number> {
  const { rows } = await pool.query(`select count(*)::int as n from ${table}`);

  return z.object({ n: z.number() }).parse(rows[0]).n;
}

async function schemas(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query(
    "select nspname from pg_namespace where nspname like 'derived%' order by nspname",
  );

  return z
    .array(z.object({ nspname: z.string() }))
    .parse(rows)
    .map(({ nspname }) => nspname);
}

/** Calls `check` every 50 ms until it returns true, and fails after 20 s. */
async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;

  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("condition not met within 20 s");
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test(
  "rebuilds a folder with every edge case into the rows that synthesize returns",
  // Building and importing every case takes a few seconds, and Vitest's default timeout is 5 s.
  { timeout: 30_000 },
  async ({ databaseUrl }) => {
    const pool = await cleanPool(databaseUrl);
    const { files, rows } = synthesizedNights(edgeCaseNames("all"), 2);

    const summary = (await run(await importContext(files), pool))._unsafeUnwrap();

    expect(summary.failed).toEqual([]);
    for (const table of [
      "nights",
      "sessions",
      "segments",
      "events",
      "samples",
      "breaths",
    ] as const) {
      expect(await count(pool, `derived.${table}`), table).toBe(rows[table].length);
    }

    const { rows: meta } = await pool.query("select derived_version from derived.meta");
    expect(meta).toEqual([{ derived_version: DERIVED_VERSION }]);
    expect(await schemas(pool)).toEqual(["derived"]);
  },
);

test("lets a query that started before the swap finish on the old tables, and runs new queries on the new tables", async ({
  databaseUrl,
}) => {
  const pool = await cleanPool(databaseUrl);
  const ctx = await importContext(syntheticFolder(3));
  (await run(ctx, pool))._unsafeUnwrap();
  // Leaves the old tables one night short, so the two builds differ.
  await pool.query(
    "delete from derived.nights where night = (select min(night) from derived.nights)",
  );
  const reader = new pg.Client(databaseUrl);
  await reader.connect();
  onTestFinished(async () => {
    await reader.end();
  });

  await reader.query("begin");
  const before = await count(reader, "derived.nights");
  const pending = run(ctx, pool);
  await until(async () => (await count(pool, "derived.nights")) === 3);
  const oldWhileOpen = await count(reader, "derived_old.nights");
  await reader.query("commit");
  const summary = await pending;

  expect(before).toBe(2);
  expect(oldWhileOpen).toBe(2);
  expect(summary.isOk()).toBe(true);
  expect(await schemas(pool)).toEqual(["derived"]);
});

test("fails with str_not_ready while STR.edf is in its 2-minute wait, and keeps derived", async ({
  databaseUrl,
}) => {
  const pool = await cleanPool(databaseUrl);
  const ctx = await importContext(syntheticFolder(2));
  (await run(ctx, pool))._unsafeUnwrap();
  const str = join(ctx.config.cpapDataPath, "STR.edf");
  await writeFile(str, await readFile(str));

  const result = await run({ ...ctx, clock: () => Temporal.Now.instant() }, pool);

  expect(result._unsafeUnwrapErr()).toEqual({ kind: "str_not_ready" });
  expect(await count(pool, "derived.nights")).toBe(2);
  expect(await schemas(pool)).toEqual(["derived"]);
});

test("fails with nothing_imported when every night fails, and keeps derived", async ({
  databaseUrl,
}) => {
  const pool = await cleanPool(databaseUrl);
  const files = syntheticFolder(2);
  (await run(await importContext(files), pool))._unsafeUnwrap();

  const result = await run(await importContext(files, () => true), pool);

  expect(result._unsafeUnwrapErr()).toEqual({ kind: "nothing_imported" });
  expect(await count(pool, "derived.nights")).toBe(2);
  expect(await schemas(pool)).toEqual(["derived"]);
});

test("fails with nights_dropped when a night's folder is gone, and swaps when allowDroppedNights is true", async ({
  databaseUrl,
}) => {
  const pool = await cleanPool(databaseUrl);
  const ctx = await importContext(syntheticFolder(3));
  (await run(ctx, pool))._unsafeUnwrap();
  const datalog = join(ctx.config.cpapDataPath, "DATALOG");
  const [first] = (await readdir(datalog)).toSorted((a, b) => a.localeCompare(b));
  await rm(join(datalog, first ?? ""), { recursive: true });

  const refused = await run(ctx, pool);
  const allowed = await run(ctx, pool, true);

  expect(refused._unsafeUnwrapErr()).toEqual({ kind: "nights_dropped", count: 1 });
  expect(allowed.isOk()).toBe(true);
  expect(await count(pool, "derived.nights")).toBe(2);
});

test("rebuilds after a crashed rebuild left derived_old and derived_next behind", async ({
  databaseUrl,
}) => {
  const pool = await cleanPool(databaseUrl);
  await pool.query("create schema derived_old; create schema derived_next");

  const result = await run(await importContext(syntheticFolder(2)), pool);

  expect(result._unsafeUnwrap()).toMatchObject({ planned: 2, committed: 2 });
  expect(await schemas(pool)).toEqual(["derived"]);
});
