// Runs one import pass over the CPAP data folder. Polls and rebuilds both call importFolder.
import type { Span } from "@opentelemetry/api";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type pg from "pg";
import type { DerivedSchema } from "@airway/contract/derived/ddl";
import { FileKind } from "@airway/contract/derived/values";
import type { WriteError } from "../db/transaction.ts";
import type { Logger } from "../logger.ts";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";
import type { EdfFileError } from "./edf.ts";
import { readIdentification, type ReadIdentificationError } from "./identification.ts";
import { ImportMetrics, timed, WriteKind, type Outcome } from "./metrics.ts";
import type { NightResult } from "./night.ts";
import { planNights, planTasks, type NightPlan } from "./planner.ts";
import type { NightPool, NightPoolError } from "./pool.ts";
import { readCpapFile } from "./read.ts";
import type { SeenFile } from "./readiness.ts";
import { scanCpapData, type ScanError, type ScannedFile } from "./scan.ts";
import type { NightFiles } from "./segments.ts";
import { readStr, type StrFile } from "./str.ts";
import { checkVersions, type FileStates, type FileVersion } from "./versions.ts";
import { checkStrHistory, writeStr, type QueryError } from "./write-str.ts";
import { writeNight, writePercentiles } from "./write.ts";

/** Counts what one import pass did. */
type ImportSummary = {
  planned: number;
  committed: number;
  /** Lists the nights whose compute or write failed. The next poll plans them again. */
  failed: Temporal.PlainDate[];
  /** Counts the nights older than STR.edf's first used day. Is null when STR.edf isn't ready. */
  nightsBeforeStr: number | null;
};

type ImportError = ScanError | EdfFileError | ReadIdentificationError | WriteError | QueryError;

/** Collects the context, connections, and telemetry that every step of one import pass reads. */
type Pass = {
  ctx: AppContext;
  client: pg.ClientBase;
  pool: pg.Pool;
  schema: DerivedSchema;
  metrics: ImportMetrics;
  logger: Logger;
  span: Span;
};

/** Groups the plan, file states, and STR.edf that the steps after planning read. */
type Planned = { plan: NightPlan; states: FileStates; str: StrFile };

type NightOutcomes = { committed: Temporal.PlainDate[]; failed: Temporal.PlainDate[] };

/** Pairs a night's task with the night pool's pending result for it. */
type ComputingNight = { task: NightFiles; result: ResultAsync<NightResult, NightPoolError> };

// A second write connection cut a full rebuild's write time by about a third. Three or more ran no
// faster than two.
const WRITERS = 2;

const readStrFile = (ctx: Pick<AppContext, "config">): ResultAsync<StrFile, EdfFileError> =>
  inSpanAsync("ingest.read_str", () =>
    readCpapFile(ctx, "STR.edf").andThen((bytes) =>
      readStr(bytes).mapErr((error): EdfFileError => ({ ...error, path: "STR.edf" })),
    ),
  );

/**
 * Yields each task with its pending result, in order, while `ahead` more tasks compute. Each yield
 * starts one more compute, which caps how many results wait for a writer.
 */
function* computeAhead(
  nightPool: NightPool,
  tasks: readonly NightFiles[],
  ahead: number,
): Generator<ComputingNight> {
  const run = (task: NightFiles): ComputingNight => ({ task, result: nightPool.run(task) });
  const queue = tasks.slice(0, ahead).map(run);
  let started = queue.length;

  for (let night = queue.shift(); night !== undefined; night = queue.shift()) {
    const following = tasks[started];

    if (following !== undefined) {
      queue.push(run(following));
      started += 1;
    }

    yield night;
  }
}

/** Writes one computed night on `connection` and records whether it committed. */
async function writeComputed(
  pass: Pass,
  connection: pg.PoolClient,
  { task, result }: ComputingNight,
  outcomes: NightOutcomes,
): Promise<void> {
  const record = (outcome: Outcome, seconds: number): void => {
    pass.metrics.wrote(WriteKind.Night, outcome, seconds);
  };

  await result
    .andThen((computed) =>
      timed(record, () => writeNight(connection, pass.schema, { task, result: computed })),
    )
    .match(
      () => {
        outcomes.committed.push(task.night);
      },
      (error) => {
        pass.logger.warn({ night: task.night.toString(), error }, "night not imported");
        outcomes.failed.push(task.night);
      },
    );
}

/** Opens one pooled connection and writes nights from the iterator on it until the iterator ends. */
async function writeNights(
  pass: Pass,
  nights: Iterator<ComputingNight>,
  outcomes: NightOutcomes,
): Promise<void> {
  await ResultAsync.fromPromise(pass.pool.connect(), (cause) => cause).match(
    async (connection) => {
      try {
        for (let night = nights.next(); night.done !== true; night = nights.next()) {
          await writeComputed(pass, connection, night.value, outcomes);
        }
      } finally {
        connection.release();
      }
    },
    (cause) => {
      pass.logger.warn({ err: cause }, "write connection not opened");
    },
  );
}

/**
 * Computes `tasks` in the night pool and writes them on `WRITERS` pooled connections. Logs each
 * night that fails and lists it in `failed`.
 */
async function importNights(pass: Pass, tasks: readonly NightFiles[]): Promise<NightOutcomes> {
  // Computing further ahead made a full rebuild about 15% slower, because the main thread spent its
  // time decoding results.
  const nights = computeAhead(pass.ctx.nightPool, tasks, pass.ctx.config.ingestWorkers * 2);
  const outcomes: NightOutcomes = { committed: [], failed: [] };

  const writers = Array.from({ length: WRITERS }, async () => {
    await writeNights(pass, nights, outcomes);
  });
  await Promise.all(writers);

  // Writers take nights in order. When no write connection opens, the remaining nights count as
  // failed.
  const handled = outcomes.committed.length + outcomes.failed.length;
  outcomes.failed.push(...tasks.slice(handled).map(({ night }) => night));

  return outcomes;
}

/**
 * Recomputes the period percentiles of `committed`. If that fails, deletes those nights' `files`
 * rows so the next poll imports them again and retries.
 */
function recomputePercentiles(
  pass: Pass,
  committed: readonly Temporal.PlainDate[],
): ResultAsync<void, WriteError> {
  const [first, ...rest] = committed;

  if (first === undefined) {
    return okAsync(undefined);
  }

  const record = (outcome: Outcome, seconds: number): void => {
    pass.metrics.recomputedPercentiles(outcome, seconds);
  };

  const forget = (error: WriteError): ResultAsync<void, WriteError> =>
    ResultAsync.fromPromise(
      pass.client.query(`delete from ${pass.schema}.files where night = any($1::date[])`, [
        committed.map(String),
      ]),
      (cause) => {
        pass.logger.error({ err: cause }, "files rows not deleted; percentiles stay stale");

        return error;
      },
    ).andThen(() => errAsync(error));

  return timed(record, () => writePercentiles(pass.client, pass.schema, [first, ...rest])).orElse(
    forget,
  );
}

/** Rewrites the STR.edf tables when `plan.rewriteStrTables` is set and Identification.tgt is ready. */
function rewriteStrTables(
  pass: Pass,
  { plan, states, str }: Planned,
): ResultAsync<void, ReadIdentificationError | WriteError> {
  if (
    !plan.rewriteStrTables ||
    !states.ready.some(({ kind }) => kind === FileKind.Identification)
  ) {
    return okAsync(undefined);
  }

  const record = (outcome: Outcome, seconds: number): void => {
    pass.metrics.wrote(WriteKind.Str, outcome, seconds);
  };

  const files = states.ready.filter(({ night }) => night === null);

  return readIdentification(pass.ctx)
    .andThen((identification) =>
      timed(record, () =>
        writeStr(pass.ctx, pass.client, pass.schema, { str, identification, files }),
      ),
    )
    .map(() => undefined);
}

/** Imports the planned nights, then updates the percentiles and the STR.edf tables. */
function importPlanned(pass: Pass, planned: Planned): ResultAsync<ImportSummary, ImportError> {
  const { plan, states, str } = planned;
  const { tasks, unused } = planTasks(plan.nights, states, str.days, pass.ctx.config.timeZone);

  if (unused.length > 0) {
    pass.logger.debug({ nights: unused.map(String) }, "nights unused in STR.edf");
  }

  pass.metrics.nightsUnused(unused.length);
  pass.span.setAttributes({
    "airway.ingest.nights_planned": tasks.length,
    "airway.ingest.nights_unused": unused.length,
  });

  return ResultAsync.fromSafePromise(importNights(pass, tasks))
    .andThen((outcomes) => recomputePercentiles(pass, outcomes.committed).map(() => outcomes))
    .andThen((outcomes) => rewriteStrTables(pass, planned).map(() => outcomes))
    .andThen(({ committed, failed }) =>
      checkStrHistory(pass.ctx, pass.client, pass.schema, str).map((nightsBeforeStr) => {
        pass.span.setAttributes({
          "airway.ingest.nights_committed": committed.length,
          "airway.ingest.nights_failed": failed.length,
        });

        return { planned: tasks.length, committed: committed.length, failed, nightsBeforeStr };
      }),
    );
}

/**
 * Runs one import pass into `target.schema`:
 *
 * 1. Scans the CPAP data folder and checks each file's version against `seen`. `since` returns the
 *    time at which a new version counts as first seen.
 * 2. Plans the nights whose ready files differ from `imported`.
 * 3. Reads STR.edf, computes each planned night in the night pool, and writes it.
 * 4. Recomputes the period percentiles of the nights that committed.
 * 5. Rewrites the STR.edf tables when STR.edf or Identification.tgt changed.
 * 6. Counts the nights older than STR.edf's first used day.
 *
 * The pass records a failed night and continues. When any other step fails, the pass stops and
 * returns that step's error.
 */
export function importFolder(
  ctx: AppContext,
  target: { client: pg.ClientBase; pool: pg.Pool; schema: DerivedSchema },
  {
    imported,
    seen,
    since,
  }: {
    imported: readonly FileVersion[];
    seen: Map<string, SeenFile>;
    since: (file: ScannedFile) => Temporal.Instant;
  },
  metrics: ImportMetrics,
): ResultAsync<ImportSummary, ImportError> {
  const logger = ctx.logger.child({ module: "ingest.import", schema: target.schema });
  const record = (outcome: Outcome, seconds: number): void => {
    metrics.imported(outcome, seconds);
  };

  return timed(record, () =>
    inSpanAsync("ingest.import", (span) => {
      const pass: Pass = { ctx, ...target, metrics, logger, span };

      return scanCpapData(ctx)
        .andThen((scan) => checkVersions(ctx, seen, scan, { now: ctx.clock(), since }))
        .andThen((states): ResultAsync<ImportSummary, ImportError> => {
          // The planner holds every night back until STR.edf is ready.
          if (!states.ready.some(({ kind }) => kind === FileKind.Str)) {
            span.setAttribute("airway.ingest.nights_planned", 0);

            return okAsync({ planned: 0, committed: 0, failed: [], nightsBeforeStr: null });
          }

          const plan = planNights(states, imported);

          return readStrFile(ctx).andThen((str) => importPlanned(pass, { plan, states, str }));
        });
    }),
  );
}
