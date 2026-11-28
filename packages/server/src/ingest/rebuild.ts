// Rebuilds every derived table into derived_next while queries keep reading derived, then swaps
// the schemas.
import { err, errAsync, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import type pg from "pg";
import {
  DERIVED_VERSION,
  derivedIndexes,
  derivedKeys,
  derivedTables,
} from "@airway/contract/derived/ddl";
import { withAdvisoryLock, type LockFailure } from "../db/lock.ts";
import { query, type QueryError } from "../db/query.ts";
import type { Logger } from "../logger.ts";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";
import { importFolder, type ImportError, type ImportSummary } from "./import.ts";
import { ImportMetrics } from "./metrics.ts";
import { scanCpapData, type Scan, type ScanError } from "./scan.ts";

type NightsDropped = { kind: "nights_dropped"; count: number };
type RefusedRebuild = NightsDropped | { kind: "str_not_ready" } | { kind: "nothing_imported" };
type RebuildError = LockFailure | ImportError | RefusedRebuild | QueryError;

/**
 * Returns `nights_dropped` when a rebuild would delete `count` nights whose folders are gone,
 * unless `allowDroppedNights` is true.
 */
export function checkDropped(
  count: number,
  allowDroppedNights: boolean,
): Result<void, NightsDropped> {
  return count > 0 && !allowDroppedNights ? err({ kind: "nights_dropped", count }) : ok(undefined);
}

/**
 * Decides whether a rebuild's import can replace `derived`. Returns `str_not_ready` when STR.edf
 * wasn't ready, and `nothing_imported` when the import committed none of its planned nights.
 * Swapping in either import would empty the tables that queries read.
 */
export function checkImport(summary: ImportSummary): Result<ImportSummary, RefusedRebuild> {
  if (summary.nightsBeforeStr === null) {
    return err({ kind: "str_not_ready" });
  }

  if (summary.planned > 0 && summary.committed === 0) {
    return err({ kind: "nothing_imported" });
  }

  return ok(summary);
}

// Counts the nights in derived whose DATALOG folder is missing from the scan. Returns 0 when
// derived.nights doesn't exist yet.
function droppedNights(client: pg.ClientBase, scan: Scan): ResultAsync<number, QueryError> {
  const folders = [
    ...new Set(scan.files.flatMap(({ night }) => (night === null ? [] : [night.toString()]))),
  ];

  return query<{ exists: boolean }>(
    client,
    "select to_regclass('derived.nights') is not null as exists",
  ).andThen(({ rows }) =>
    rows[0]?.exists === true
      ? query<{ n: number }>(
          client,
          "select count(*)::int as n from derived.nights where not (night = any($1::date[]))",
          [folders],
        ).map((result) => result.rows[0]?.n ?? 0)
      : okAsync(0),
  );
}

/**
 * Fails with `nights_dropped` when the rebuild would delete nights. Otherwise drops any derived_old
 * or derived_next that a crashed rebuild left behind, and creates derived_next with its indexes.
 */
function prepare(
  ctx: AppContext,
  client: pg.ClientBase,
  allowDroppedNights: boolean,
): ResultAsync<void, ScanError | QueryError | NightsDropped> {
  return scanCpapData(ctx)
    .andThen((scan) => droppedNights(client, scan))
    .andThen((count) => checkDropped(count, allowDroppedNights))
    .andThen(() =>
      query(
        client,
        `drop schema if exists derived_old cascade;
         drop schema if exists derived_next cascade;
         ${derivedTables("derived_next")}
         ${derivedIndexes("derived_next")}`,
      ),
    )
    .map(() => undefined);
}

/**
 * Imports the folder into derived_next, rejects an import that would empty the tables, and adds
 * the foreign keys and meta row.
 */
function load(
  ctx: AppContext,
  { client, pool }: { client: pg.ClientBase; pool: pg.Pool },
): ResultAsync<ImportSummary, ImportError | RefusedRebuild | QueryError> {
  return importFolder(
    ctx,
    { client, pool, schema: "derived_next" },
    { imported: [], seen: new Map(), since: (file) => file.ctime },
    new ImportMetrics(),
  )
    .andThen((summary): Result<ImportSummary, RefusedRebuild> => checkImport(summary))
    .andThen((summary) =>
      query(client, derivedKeys("derived_next"))
        .andThen(() =>
          query(
            client,
            "insert into derived_next.meta (derived_version, built_at) values ($1, $2)",
            [DERIVED_VERSION, ctx.clock().toString()],
          ),
        )
        .map(() => summary),
    );
}

// Ignores a failed drop, because each rebuild drops a leftover derived_next before it imports.
const discardNext = (client: pg.ClientBase): ResultAsync<void, never> =>
  query(client, "drop schema if exists derived_next cascade")
    .map(() => undefined)
    .orElse(() => okAsync(undefined));

/** Renames derived to derived_old and derived_next to derived in one statement, then drops derived_old. */
function swap(client: pg.ClientBase, logger: Logger): ResultAsync<void, QueryError> {
  return query(
    client,
    `do $$ begin
       if to_regnamespace('derived') is not null then
         alter schema derived rename to derived_old;
       end if;
       alter schema derived_next rename to derived;
     end $$`,
  ).andThen(() =>
    query(client, "drop schema if exists derived_old cascade")
      .map(() => undefined)
      .orElse((error) => {
        // The swap committed, so the rebuild succeeded. The next rebuild drops derived_old.
        logger.warn({ error }, "derived_old not dropped");

        return okAsync(undefined);
      }),
  );
}

/**
 * Rebuilds the derived tables from the CPAP data folder and swaps them in, holding airway's
 * advisory lock for the whole run. It waits up to `lockTimeout` for the lock.
 *
 * 1. Fails with `nights_dropped` when derived has nights whose folders are missing from the scan,
 *    unless `allowDroppedNights` is true.
 * 2. Drops any derived_old or derived_next that a crashed rebuild left behind, and creates
 *    derived_next with its indexes.
 * 3. Imports the whole folder into derived_next. A file whose ctime is more than 2 minutes old is
 *    ready at once.
 * 4. Fails with `str_not_ready` or `nothing_imported` when the import would empty the tables.
 * 5. Adds the foreign keys and writes the meta row.
 * 6. Renames derived to derived_old and derived_next to derived in one statement, then drops
 *    derived_old. The drop waits until queries on the old tables finish.
 *
 * On a failure before the swap, it drops derived_next, and derived keeps serving.
 */
export function rebuild(
  ctx: AppContext,
  pool: pg.Pool,
  {
    allowDroppedNights,
    lockTimeout,
  }: { allowDroppedNights: boolean; lockTimeout: Temporal.Duration },
): ResultAsync<ImportSummary, RebuildError> {
  const logger = ctx.logger.child({ module: "ingest.rebuild" });

  return inSpanAsync("ingest.rebuild", (span) =>
    withAdvisoryLock(pool, { kind: "wait", timeout: lockTimeout }, (client) =>
      prepare(ctx, client, allowDroppedNights)
        .andThen(() => load(ctx, { client, pool }))
        .orElse((error) => discardNext(client).andThen(() => errAsync(error)))
        .andThen((summary) => swap(client, logger).map(() => summary)),
    ).map((summary) => {
      span.setAttributes({
        "airway.ingest.nights_planned": summary.planned,
        "airway.ingest.nights_committed": summary.committed,
        "airway.ingest.nights_failed": summary.failed.length,
      });
      logger.info({ ...summary, failed: summary.failed.map(String) }, "derived rebuilt");

      return summary;
    }),
  );
}
