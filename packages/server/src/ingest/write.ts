// Writes one night's rows, and recomputes the period percentiles for the nights that an import pass
// wrote.
import { errAsync, type ResultAsync } from "neverthrow";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import type { DerivedSchema } from "@airway/contract/derived/ddl";
import { possiblyCorrupted } from "@airway/contract/derived/nights";
import { recomputePeriodPercentiles } from "@airway/contract/derived/percentiles";
import type { FileRow } from "@airway/contract/derived/rows";
import { FileChecksum } from "@airway/contract/derived/values";
import { inTransaction, type WriteError } from "../db/transaction.ts";
import { inSpanAsync } from "../telemetry.ts";
import { BREATH_COLUMNS, breathLines, SAMPLE_COLUMNS, sampleLines } from "./copy.ts";
import type { NightResult } from "./night.ts";
import type { NightFiles } from "./segments.ts";

/**
 * Reports a night whose task lists zero ready files, so `arrivedAt` returns undefined. The planner
 * plans only nights that have a new ready file.
 */
export type NoReadyFiles = { kind: "no_ready_files"; night: Temporal.PlainDate };

/** Pairs a night's task with the result that `computeNight` returned for it. */
export type ComputedNight = { task: NightFiles; result: NightResult };

/** Counts the rows that `writeNight` wrote to each table. */
export type NightCounts = Record<
  "sessions" | "segments" | "events" | "files" | "samples" | "breaths",
  number
>;

/** Returns the newest ctime among the night's ready files, or undefined when it has none. */
function arrivedAt(task: NightFiles): Temporal.Instant | undefined {
  return [...task.files, ...task.eveFiles, ...task.crcFiles]
    .map(({ ctime }) => ctime)
    .reduce<Temporal.Instant | undefined>(
      (newest, ctime) =>
        newest === undefined || Temporal.Instant.compare(ctime, newest) > 0 ? ctime : newest,
      undefined,
    );
}

/** Returns the `files` rows of the night's ready BRP, PLD, EVE, and `.crc` files. */
function fileRows(task: NightFiles, result: NightResult): FileRow[] {
  const segmentOf = new Map(
    result.segments.segments.flatMap(({ segment, brp, plds }) =>
      [brp, ...plds].map(({ path }): [string, number] => [path, segment]),
    ),
  );
  const checks = new Map(result.checks.map((check) => [check.path, check]));

  return [...task.files, ...task.eveFiles, ...task.crcFiles].map(
    ({ path, kind, size, sha256, ctime }): FileRow => ({
      path,
      kind,
      night: task.night,
      segment: segmentOf.get(path) ?? null,
      size,
      sha256,
      ctime,
      checksum: checks.get(path)?.checksum ?? FileChecksum.Unchecked,
      bad_records: checks.get(path)?.bad_records ?? null,
    }),
  );
}

// Inserts `rows` into `table` with one parameter array per column, so one statement inserts all of
// a table's rows.
async function insertRows(
  client: pg.ClientBase,
  table: string,
  columns: readonly (readonly [name: string, type: string])[],
  rows: readonly (readonly unknown[])[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await client.query(
    `insert into ${table} (${columns.map(([name]) => name).join(", ")})
     select * from unnest(${columns.map(([, type], i) => `$${(i + 1).toString()}::${type}[]`).join(", ")})`,
    columns.map((_column, i) => rows.map((row) => row[i])),
  );
}

const text = (value: Temporal.Instant | Temporal.PlainDate): string => value.toString();

const BATCH_LINES = 5000;

// Yields every block's lines in order, without holding them all in memory.
function* linesOf<B>(
  blocks: readonly B[],
  lines: (block: B) => Iterable<string>,
): Generator<string> {
  for (const block of blocks) {
    yield* lines(block);
  }
}

// Joins every BATCH_LINES lines into one string, because the stream writes a few large chunks
// faster than one chunk per row.
function* batched(lines: Iterable<string>): Generator<string> {
  let batch: string[] = [];

  for (const line of lines) {
    batch.push(line);

    if (batch.length === BATCH_LINES) {
      yield batch.join("");
      batch = [];
    }
  }

  if (batch.length > 0) {
    yield batch.join("");
  }
}

// COPYs `lines` into `table`'s `columns`.
async function copyRows(
  client: pg.ClientBase,
  table: string,
  columns: readonly string[],
  lines: Iterable<string>,
): Promise<void> {
  await pipeline(
    Readable.from(batched(lines)),
    client.query(copyFrom(`copy ${table} (${columns.join(", ")}) from stdin`)),
  );
}

/**
 * Replaces one night's rows in one transaction, in an `ingest.write_night` span. It deletes the
 * night's samples, breaths, and `nights` row, and the delete cascades to the night's other tables.
 * It then inserts the nights, sessions, segments, events, and `files` rows, and COPYs the samples
 * and breaths. A failed statement rolls back the whole night.
 *
 * `arrived_at` is the newest ctime among the night's ready files. `possibly_corrupted` comes from
 * the files' checks and the number of rejected files. Each BRP and PLD row stores its segment
 * number. Header-only files, PLD files outside every segment, EVE files, and `.crc` files have a
 * null segment.
 */
export function writeNight(
  client: pg.ClientBase,
  schema: DerivedSchema,
  { task, result }: ComputedNight,
): ResultAsync<NightCounts, WriteError | NoReadyFiles> {
  const arrived = arrivedAt(task);

  if (arrived === undefined) {
    return errAsync({ kind: "no_ready_files", night: task.night });
  }

  const night = task.night.toString();
  const { row } = result.scored;
  const { signals, ...computed } = row;
  const nightRow = {
    ...computed,
    ...signals,
    night,
    possibly_corrupted: possiblyCorrupted(result.checks, task.rejected.length),
    arrived_at: text(arrived),
  };
  const files = fileRows(task, result);
  const counts: NightCounts = {
    sessions: result.segments.sessions.length,
    segments: result.segments.segments.length,
    events: result.scored.events.length,
    files: files.length,
    samples: result.samples.reduce((sum, { ts }) => sum + ts.length, 0),
    breaths: result.breaths.reduce((sum, { ts }) => sum + ts.length, 0),
  };

  return inSpanAsync("ingest.write_night", (span) => {
    span.setAttribute("airway.night", night);

    return inTransaction(client, schema, async () => {
      const columns = Object.keys(nightRow);

      await client.query("delete from nights where night = $1", [night]);
      await client.query(
        `insert into nights (${columns.join(", ")})
         values (${columns.map((_column, i) => `$${(i + 1).toString()}`).join(", ")})`,
        Object.values(nightRow),
      );
      await insertRows(
        client,
        "sessions",
        [
          ["night", "date"],
          ["session", "smallint"],
          ["ts", "timestamptz"],
          ["ended_at", "timestamptz"],
          ["source", "text"],
        ],
        result.segments.sessions.map(({ session, start, end, source }) => [
          night,
          session,
          text(start),
          text(end),
          source,
        ]),
      );
      await insertRows(
        client,
        "segments",
        [
          ["night", "date"],
          ["segment", "smallint"],
          ["session", "smallint"],
          ["ts", "timestamptz"],
          ["ended_at", "timestamptz"],
        ],
        result.segments.segments.map(({ segment, session, start, end }) => [
          night,
          segment,
          session,
          text(start),
          text(end),
        ]),
      );
      await insertRows(
        client,
        "events",
        [
          ["night", "date"],
          ["session", "smallint"],
          ["ts", "timestamptz"],
          ["duration", "double precision"],
          ["type", "text"],
          ["label", "text"],
          ["source", "text"],
          ["outside_mask_on", "boolean"],
        ],
        result.scored.events.map((event) => [
          night,
          event.session,
          text(event.ts),
          event.duration,
          event.type,
          event.label,
          event.source,
          event.outside_mask_on,
        ]),
      );
      await insertRows(
        client,
        "files",
        [
          ["path", "text"],
          ["kind", "text"],
          ["night", "date"],
          ["segment", "smallint"],
          ["size", "bigint"],
          ["sha256", "text"],
          ["ctime", "timestamptz"],
          ["checksum", "text"],
          ["bad_records", "integer"],
        ],
        files.map((file) => [
          file.path,
          file.kind,
          night,
          file.segment,
          file.size,
          file.sha256,
          text(file.ctime),
          file.checksum,
          file.bad_records,
        ]),
      );
      await copyRows(
        client,
        "samples",
        SAMPLE_COLUMNS,
        linesOf(result.samples, (block) => sampleLines(task.night, block)),
      );
      await copyRows(
        client,
        "breaths",
        BREATH_COLUMNS,
        linesOf(result.breaths, (block) => breathLines(task.night, block)),
      );

      return counts;
    }).map((written) => {
      span.setAttributes(
        Object.fromEntries(
          Object.entries(written).map(([table, n]) => [`airway.rows.${table}`, n]),
        ),
      );

      return written;
    });
  });
}

/**
 * Recomputes the period percentiles of each week and month that `nights` fall in. It runs in one
 * transaction inside an `ingest.write_percentiles` span, and sets the span's `airway.nights`
 * attribute to the number of nights.
 */
export function writePercentiles(
  client: pg.ClientBase,
  schema: DerivedSchema,
  nights: readonly [Temporal.PlainDate, ...Temporal.PlainDate[]],
): ResultAsync<void, WriteError> {
  return inSpanAsync("ingest.write_percentiles", (span) => {
    span.setAttribute("airway.nights", nights.length);

    return inTransaction(client, schema, async () => {
      await client.query(recomputePeriodPercentiles(schema, nights));
    });
  });
}
