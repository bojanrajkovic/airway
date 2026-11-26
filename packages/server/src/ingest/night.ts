// Computes everything ingest writes for one night. A worker thread calls `computeNight`, and the
// main thread writes the result to the database.
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import { transformer } from "@airway/contract/transformer";
import type { AppContext } from "../runtime/context.ts";
import { readBreaths, type BreathBlock } from "./breaths.ts";
import type { EdfFileError } from "./edf.ts";
import { scoreNight, type ScoredEvents } from "./events.ts";
import { readSamples, type SampleBlock } from "./samples.ts";
import { buildNight, type NightFiles, type NightSegments } from "./segments.ts";

/** Names the steps of `computeNight`, in the order it runs them. */
export enum NightStep {
  Segments = "segments",
  Events = "events",
  Samples = "samples",
  Breaths = "breaths",
}

/** Contains everything ingest writes for one night, plus the seconds each step took. */
export type NightResult = {
  night: Temporal.PlainDate;
  segments: NightSegments;
  scored: ScoredEvents;
  samples: SampleBlock[];
  breaths: BreathBlock[];
  /** Maps each step to the seconds it took. */
  steps: Record<NightStep, number>;
};

/**
 * Builds a night's segments and sessions, scores its events, and reads its samples and breaths, in
 * that order. Times each step with `performance.now()`. Reads only the night's files, so a worker
 * thread without database pools can run it.
 */
export function computeNight(
  ctx: Pick<AppContext, "config" | "logger">,
  task: NightFiles,
): ResultAsync<NightResult, EdfFileError> {
  let mark = performance.now();
  const lap = (): number => {
    const now = performance.now();
    const seconds = (now - mark) / 1000;
    mark = now;

    return seconds;
  };

  const segments = buildNight(ctx, task);
  const segmentsSeconds = lap();
  const planned = { night: task.night, zone: task.zone, segments: segments.segments };

  return scoreNight(ctx, { ...task, files: task.eveFiles, sessions: segments })
    .map((scored) => ({ scored, events: lap() }))
    .andThen((done) =>
      readSamples(ctx, planned).map((samples) => ({ ...done, samples, samplesSeconds: lap() })),
    )
    .andThen((done) =>
      readBreaths(ctx, planned).map((breaths): NightResult => ({
        night: task.night,
        segments,
        scored: done.scored,
        samples: done.samples,
        breaths,
        steps: {
          [NightStep.Segments]: segmentsSeconds,
          [NightStep.Events]: done.events,
          [NightStep.Samples]: done.samplesSeconds,
          [NightStep.Breaths]: lap(),
        },
      })),
    );
}

type Serialized = ReturnType<typeof transformer.serialize>;

/**
 * Stores a night's result in a form that `postMessage` can send. Structured cloning can't copy
 * Temporal values, so `payload` stores them as superjson. The sample and breath columns stay typed
 * arrays, and the sender transfers their buffers instead of copying them. An error contains only
 * plain values and `Error` objects, so structured cloning copies it directly. When the error's
 * `cause` is an `Error`, structured cloning preserves that `Error`'s stack.
 */
export type NightWire =
  | { ok: true; payload: Serialized; samples: SampleBlock[]; breaths: BreathBlock[] }
  | { ok: false; error: EdfFileError };

/** Pairs a `NightWire` with the buffers to transfer along with it. */
export type EncodedNight = { wire: NightWire; transfer: ArrayBuffer[] };

// Returns each distinct ArrayBuffer that backs the blocks' typed arrays.
function buffersOf(
  samples: readonly SampleBlock[],
  breaths: readonly BreathBlock[],
): ArrayBuffer[] {
  const arrays = [
    ...samples.flatMap(({ ts, signals }) => [ts, ...Object.values(signals)]),
    ...breaths.flatMap(({ ts, duration, amplitude, inspiratory_volume }) => [
      ts,
      duration,
      amplitude,
      inspiratory_volume,
    ]),
  ];
  const buffers = new Set<ArrayBuffer>();

  for (const { buffer } of arrays) {
    if (buffer instanceof ArrayBuffer) {
      buffers.add(buffer);
    }
  }

  return [...buffers];
}

/** Encodes a night's result for `postMessage`, and lists the buffers to transfer. */
export function encodeNight(result: Result<NightResult, EdfFileError>): EncodedNight {
  return result.match(
    ({ samples, breaths, ...rest }): EncodedNight => ({
      wire: { ok: true, payload: transformer.serialize(rest), samples, breaths },
      transfer: buffersOf(samples, breaths),
    }),
    (error): EncodedNight => ({ wire: { ok: false, error }, transfer: [] }),
  );
}

/** Rebuilds the result that `encodeNight` encoded, Temporal values included. */
export function decodeNight(wire: NightWire): Result<NightResult, EdfFileError> {
  return wire.ok
    ? ok({
        ...transformer.deserialize<Omit<NightResult, "samples" | "breaths">>(wire.payload),
        samples: wire.samples,
        breaths: wire.breaths,
      })
    : err(wire.error);
}

/**
 * Encodes a night's files for `postMessage`. Structured cloning can't copy the task's Temporal
 * values, which are the night, each file's ctime, and each header's start.
 */
export const encodeTask = (task: NightFiles): Serialized => transformer.serialize(task);

/** Rebuilds the task that `encodeTask` encoded. */
export const decodeTask = (payload: Serialized): NightFiles =>
  transformer.deserialize<NightFiles>(payload);
