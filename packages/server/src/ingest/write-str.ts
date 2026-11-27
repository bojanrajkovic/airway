// Writes the tables that come from STR.edf and Identification.tgt: daily_usage, settings_changes,
// device, and those files' `files` rows.
import type pg from "pg";
import { okAsync, ResultAsync } from "neverthrow";
import type { DerivedSchema } from "@airway/contract/derived/ddl";
import { settingsChanges } from "@airway/contract/derived/settings";
import type { UsedStrDay } from "@airway/contract/derived/str";
import { FileChecksum, FileKind } from "@airway/contract/derived/values";
import type { AppContext } from "../runtime/context.ts";
import { inTransaction, type WriteError } from "../db/transaction.ts";
import { inSpanAsync } from "../telemetry.ts";
import type { Identification } from "./identification.ts";
import type { StrFile } from "./str.ts";
import type { ReadyFile } from "./versions.ts";

/** Reports a database read that failed. */
export type QueryError = { kind: "query_failed"; cause: unknown };

/** Collects the parsed STR.edf, the device identification, and the root files' versions that `writeStr` writes. */
export type StrInput = {
  str: StrFile;
  identification: Identification;
  /** Lists the ready STR.edf and Identification.tgt, and Identification.crc when the folder has one. */
  files: readonly ReadyFile[];
};

/** Counts the rows that `writeStr` wrote to each table. */
export type StrCounts = { daily_usage: number; settings_changes: number; files: number };

/** Returns STR.edf's first used day, or undefined when the machine was never used. */
const firstUsedDay = (str: StrFile): Temporal.PlainDate | undefined =>
  str.days.find(({ used }) => used)?.day;

/**
 * Replaces daily_usage, settings_changes, device, and the `files` rows of STR.edf,
 * Identification.tgt, and Identification.crc, in one transaction in an `ingest.write_str` span.
 *
 * - `daily_usage` has a row for every STR.edf day from the first used day on. An unused day has
 *   0 hours.
 * - `settings_changes` has a row for each setting that changed between a used day and the used
 *   day before it, from the first used day on.
 * - STR.edf's row is `unchecked`, with `bad_records` set to the number of records whose Crc16
 *   doesn't match. Identification.tgt's row records the result of the Identification.crc check. Identification.crc's row is
 *   `unchecked`.
 *
 * Logs STR.edf's bad records and `date_mismatch` warnings at `warn`. On a failure, the previous
 * rows stay in place.
 */
export function writeStr(
  ctx: Pick<AppContext, "logger">,
  client: pg.ClientBase,
  schema: DerivedSchema,
  { str, identification, files }: StrInput,
): ResultAsync<StrCounts, WriteError> {
  const logger = ctx.logger.child({ module: "ingest.write_str" });
  const first = firstUsedDay(str);
  const days =
    first === undefined
      ? []
      : str.days.filter(({ day }) => Temporal.PlainDate.compare(day, first) >= 0);
  const changes = first === undefined ? [] : settingsChanges(str.days, first);
  const rootFiles = files.filter(({ night }) => night === null);
  const checksum = ({ kind }: ReadyFile): FileChecksum =>
    kind === FileKind.Identification ? identification.check : FileChecksum.Unchecked;
  const badRecords = ({ kind }: ReadyFile): number | null =>
    kind === FileKind.Str ? str.badRecords.length : null;

  return inSpanAsync("ingest.write_str", (span) =>
    inTransaction(client, schema, async () => {
      await client.query("delete from daily_usage");
      await client.query("delete from settings_changes");
      await client.query("delete from device");
      await client.query("delete from files where night is null");
      await client.query(
        "insert into daily_usage (day, usage) select * from unnest($1::date[], $2::double precision[])",
        [
          days.map(({ day }) => day.toString()),
          days.map((day) => (day.used ? (usage(day) ?? 0) : 0)),
        ],
      );
      await client.query(
        `insert into settings_changes (night, setting, old_value, new_value)
         select * from unnest($1::date[], $2::text[], $3::double precision[], $4::double precision[])`,
        [
          changes.map(({ night }) => night.toString()),
          changes.map(({ setting }) => setting),
          changes.map(({ old_value }) => old_value),
          changes.map(({ new_value }) => new_value),
        ],
      );
      await client.query("insert into device (serial, model) values ($1, $2)", [
        identification.device.serial,
        identification.device.model,
      ]);
      await client.query(
        `insert into files (path, kind, night, segment, size, sha256, ctime, checksum, bad_records)
         select path, kind, null, null, size, sha256, ctime, checksum, bad_records
         from unnest($1::text[], $2::text[], $3::bigint[], $4::text[], $5::timestamptz[], $6::text[], $7::int[])
           as f (path, kind, size, sha256, ctime, checksum, bad_records)`,
        [
          rootFiles.map(({ path }) => path),
          rootFiles.map(({ kind }) => kind),
          rootFiles.map(({ size }) => size),
          rootFiles.map(({ sha256 }) => sha256),
          rootFiles.map(({ ctime }) => ctime.toString()),
          rootFiles.map(checksum),
          rootFiles.map(badRecords),
        ],
      );

      return {
        daily_usage: days.length,
        settings_changes: changes.length,
        files: rootFiles.length,
      };
    }).map((counts) => {
      span.setAttributes({
        "airway.rows.daily_usage": counts.daily_usage,
        "airway.rows.settings_changes": counts.settings_changes,
        "airway.rows.files": counts.files,
        "airway.device.serial": identification.device.serial,
        "airway.device.model": identification.device.model,
      });
      if (str.badRecords.length > 0) {
        logger.warn({ badRecords: str.badRecords }, "STR.edf records don't match their Crc16");
      }

      if (str.warnings.length > 0) {
        logger.warn(
          { warnings: str.warnings },
          "STR.edf records' Date fields don't match their positions",
        );
      }

      return counts;
    }),
  );
}

const usage = (day: UsedStrDay): number | null => day.signals["usage"] ?? null;

/**
 * Returns how many `nights` rows are older than STR.edf's first used day, and logs a `warn` when
 * there are any. Such nights mean STR.edf restarted its history after a new SD card or a machine
 * reset. `writeStr` has already deleted the usage of the days before the restart. Returns 0 when
 * STR.edf has no used day.
 */
export function checkStrHistory(
  ctx: Pick<AppContext, "logger">,
  client: pg.ClientBase,
  schema: DerivedSchema,
  str: StrFile,
): ResultAsync<number, QueryError> {
  const first = firstUsedDay(str);

  if (first === undefined) {
    return okAsync(0);
  }

  return ResultAsync.fromPromise(
    client.query<{ count: string }>(
      `select count(*) as count from ${schema}.nights where night < $1::date`,
      [first.toString()],
    ),
    (cause): QueryError => ({ kind: "query_failed", cause }),
  ).map(({ rows }) => {
    const count = Number(rows[0]?.count ?? 0);

    if (count > 0) {
      ctx.logger
        .child({ module: "ingest.write_str" })
        .warn(
          { nights: count, firstUsedDay: first.toString() },
          "nights are older than STR.edf's first used day",
        );
    }

    return count;
  });
}
