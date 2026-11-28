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
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";
import { importFolder, type ImportError, type ImportSummary } from "./import.ts";
import { ImportMetrics } from "./metrics.ts";
import { scanCpapData, type Scan } from "./scan.ts";

type NightsDropped = { kind: "nights_dropped"; count: number };
type RefusedRebuild = NightsDropped | { kind: "str_not_ready" } | { kind: "nothing_imported" };
type RebuildFailed = { kind: "rebuild_failed"; cause: unknown };
type RebuildError = LockFailure | ImportError | RefusedRebuild | RebuildFailed;

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

const sql = <R extends pg.QueryResultRow = pg.QueryResultRow>(
  client: pg.ClientBase,
  text: string,
  values: unknown[] = [],
): ResultAsync<pg.QueryResult<R>, RebuildFailed> =>
  ResultAsync.fromPromise(client.query<R>(text, values), (cause) => ({
    kind: "rebuild_failed" as const,
    cause,
  }));

// Counts the nights in derived whose DATALOG folder is missing from the scan. Returns 0 when
// derived.nights doesn't exist yet.
function droppedNights(client: pg.ClientBase, scan: Scan): ResultAsync<number, RebuildFailed> {
  const folders = [
    ...new Set(scan.files.flatMap(({ night }) => (night === null ? [] : [night.toString()]))),
  ];

  return sql<{ exists: boolean }>(
    client,
    "select to_regclass('derived.nights') is not null as exists",
  ).andThen(({ rows }) =>
    rows[0]?.exists === true
      ? sql<{ n: number }>(
          client,
          "select count(*)::int as n from derived.nights where not (night = any($1::date[]))",
          [folders],
        ).map((result) => result.rows[0]?.n ?? 0)
      : okAsync(0),
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
  const metrics = new ImportMetrics();

  return inSpanAsync("ingest.rebuild", (span) =>
    withAdvisoryLock(pool, { kind: "wait", timeout: lockTimeout }, (client) =>
      scanCpapData(ctx)
        .andThen((scan) => droppedNights(client, scan))
        .andThen((count): Result<void, RefusedRebuild> => checkDropped(count, allowDroppedNights))
        .andThen(() =>
          sql(
            client,
            `drop schema if exists derived_old cascade;
             drop schema if exists derived_next cascade;
             ${derivedTables("derived_next")}
             ${derivedIndexes("derived_next")}`,
          ),
        )
        .andThen(() =>
          importFolder(
            ctx,
            { client, pool, schema: "derived_next" },
            { imported: [], seen: new Map(), since: (file) => file.ctime },
            metrics,
          ),
        )
        .andThen((summary): Result<ImportSummary, ImportError | RefusedRebuild> =>
          checkImport(summary),
        )
        .andThen((summary) =>
          sql(client, derivedKeys("derived_next"))
            .andThen(() =>
              sql(
                client,
                "insert into derived_next.meta (derived_version, built_at) values ($1, $2)",
                [DERIVED_VERSION, ctx.clock().toString()],
              ),
            )
            .map(() => summary),
        )
        .orElse((error) =>
          // derived keeps serving. The next rebuild also drops derived_next, so a failed cleanup
          // leaves derived_next on disk only until then.
          sql(client, "drop schema if exists derived_next cascade")
            .orElse(() => okAsync(undefined))
            .andThen(() => errAsync(error)),
        )
        .andThen((summary) =>
          sql(
            client,
            `do $$ begin
               if to_regnamespace('derived') is not null then
                 alter schema derived rename to derived_old;
               end if;
               alter schema derived_next rename to derived;
             end $$`,
          ).map(() => summary),
        )
        .andThen((summary) =>
          sql(client, "drop schema if exists derived_old cascade")
            .orElse((error) => {
              // The swap committed, so the rebuild succeeded. The next rebuild drops derived_old.
              logger.warn({ error }, "derived_old not dropped");

              return okAsync(undefined);
            })
            .map(() => summary),
        ),
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
