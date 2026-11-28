// Runs each night's computation in a piscina worker pool, so a long import never blocks the main
// thread's HTTP handling.
import { err, ResultAsync, type Result } from "neverthrow";
import { Piscina } from "piscina";
import { transformer } from "@airway/contract/transformer";
import type { AppContext } from "../runtime/context.ts";
import { currentTraceparent, inSpanAsync } from "../telemetry.ts";
import type { EdfFileError } from "./edf.ts";
import { IngestMetrics } from "./metrics.ts";
import { decodeNight, encodeTask, type NightResult, type NightWire } from "./night.ts";
import type { WorkerData, WorkerMessage } from "./night-worker.ts";
import type { NightFiles } from "./segments.ts";

/**
 * Resolves to a step's `EdfFileError`, or to `worker_failed` when a worker crashed or couldn't load.
 */
export type NightPoolError = EdfFileError | { kind: "worker_failed"; cause: unknown };

/** Runs nights in worker threads. `ready` becomes true when a worker returns `"ready"` for the warm-up. */
export type NightPool = AsyncDisposable & {
  readonly ready: boolean;
  /**
   * Runs a warm-up task, which checks that a worker loads. On failure, it logs the error and leaves
   * `ready` false.
   */
  warmUp: () => Promise<void>;
  /** Computes one night in a worker, in an `ingest.night` span, and records its metrics. */
  run: (task: NightFiles) => ResultAsync<NightResult, NightPoolError>;
};

/**
 * Starts a pool of up to `config.ingestWorkers` threads that run the worker at `filename`. One
 * thread starts immediately. Workers wait for tasks with `Atomics.waitAsync`, because a blocking
 * wait would freeze an idle worker's event loop and stop its telemetry from exporting. The pool
 * lowers their priority, so the main thread's requests run first when the CPUs are busy.
 */
export function createNightPool(
  ctx: Pick<AppContext, "config" | "logger">,
  { filename }: { filename: string },
): NightPool {
  const logger = ctx.logger.child({ module: "ingest.pool" });
  const workerData: WorkerData = { config: transformer.serialize(ctx.config) };
  const pool = new Piscina<WorkerMessage, "ready" | NightWire>({
    filename,
    minThreads: 1,
    maxThreads: ctx.config.ingestWorkers,
    // With piscina's default of 0, the pool stops an extra thread as soon as it goes idle and starts
    // another for the next task. Each new thread loads the worker bundle and the telemetry preload
    // again.
    idleTimeout: 60_000,
    atomics: "async",
    niceIncrement: 10,
    workerData,
  });
  const metrics = new IngestMetrics();
  let ready = false;

  // piscina emits `error` when a worker fails outside a task, for example when it can't load. An
  // `error` event with no listener throws and stops the server.
  pool.on("error", (error: unknown) => {
    logger.error({ err: error }, "night worker failed");
  });

  const workerFailed = (cause: unknown): NightPoolError => ({ kind: "worker_failed", cause });

  return {
    get ready() {
      return ready;
    },

    async warmUp() {
      await ResultAsync.fromPromise(pool.run({ kind: "warm_up" }), workerFailed).match(
        (answer) => {
          ready = answer === "ready";
        },
        (error) => {
          logger.error({ error }, "night worker failed to start");
        },
      );
    },

    run(task) {
      return inSpanAsync("ingest.night", (span) => {
        span.setAttribute("airway.night", task.night.toString());
        const started = performance.now();
        const message: WorkerMessage = {
          kind: "night",
          task: encodeTask(task),
          traceparent: currentTraceparent(),
        };

        const elapsed = (): number => (performance.now() - started) / 1000;

        return ResultAsync.fromPromise(pool.run(message), workerFailed)
          .andThen((answer): Result<NightResult, NightPoolError> =>
            answer === "ready"
              ? err(workerFailed(new Error('the worker returned "ready" for a night task')))
              : decodeNight(answer),
          )
          .andTee((night) => {
            metrics.succeeded(task, night, elapsed());
          })
          .orTee((error) => {
            metrics.failed(task, error, elapsed());
          });
      });
    },

    async [Symbol.asyncDispose]() {
      await pool.destroy();
    },
  };
}
