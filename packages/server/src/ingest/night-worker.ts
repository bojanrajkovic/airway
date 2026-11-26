// Computes nights for the night pool. The build bundles this file as dist/night-worker.js. Each
// worker thread loads it once and runs one task at a time. Workers inherit the main thread's
// `--import instrument.js`, so each one exports its own spans.
import { context } from "@opentelemetry/api";
import { move, transferableSymbol, valueSymbol, workerData } from "piscina";
import { transformer } from "@airway/contract/transformer";
import type { Config } from "../config.ts";
import { createLogger, type Logger } from "../logger.ts";
import { contextOf, flushSpans, inSpanAsync } from "../telemetry.ts";
import { computeNight, decodeTask, encodeNight, type EncodedNight } from "./night.ts";

type Serialized = ReturnType<typeof transformer.serialize>;

/**
 * Lists the messages a worker handles. For `warm_up`, the worker returns `"ready"` to tell the pool
 * that the bundle loaded. For `night`, it computes one night.
 */
export type WorkerMessage =
  | { kind: "warm_up" }
  | { kind: "night"; task: Serialized; traceparent: string | null };

/** Resolves to the data that the pool passes to each worker thread at startup. */
export type WorkerData = { config: Serialized };

/** Resolves to the parts of AppContext that `computeNight` uses. */
type WorkerContext = { config: Config; logger: Logger };

let ctx: WorkerContext | undefined = undefined;

// Builds the worker's context once, from the config that the pool passed in `workerData`.
function workerContext(data: WorkerData): WorkerContext {
  if (ctx === undefined) {
    const config = transformer.deserialize<Config>(data.config);
    ctx = { config, logger: createLogger(config.logLevel).child({ module: "ingest.worker" }) };
  }

  return ctx;
}

/**
 * Computes the night in `message` in an `ingest.compute` span, whose parent is the caller's span.
 * Returns the encoded result.
 */
export async function handle(
  message: WorkerMessage,
  data: WorkerData,
): Promise<"ready" | EncodedNight> {
  if (message.kind === "warm_up") {
    return "ready";
  }

  const task = decodeTask(message.task);
  const result = await context.with(contextOf(message.traceparent), () =>
    inSpanAsync("ingest.compute", (span) => {
      span.setAttribute("airway.night", task.night.toString());

      return computeNight(workerContext(data), task);
    }),
  );

  return encodeNight(result);
}

/** Handles one message from the pool and moves the result's buffers back to the main thread. */
export default async function run(message: WorkerMessage): Promise<unknown> {
  // piscina's `workerData` is the value that the pool passed when it started this thread.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the pool always passes WorkerData
  const result = await handle(message, workerData as WorkerData);
  await flushSpans();

  return result === "ready"
    ? result
    : move({ [transferableSymbol]: result.transfer, [valueSymbol]: result.wire });
}
