// Detects breaths in each night's 25 Hz flow and turns them into columns for the breaths table.
// The filter, thresholds, and detector come from a breath-detection prototype. In the prototype,
// they produced a breath rate that matched the machine's RespRate.
import { ResultAsync } from "neverthrow";
import { toInstant } from "@airway/contract/clock";
import { decimalsForStep, round } from "@airway/contract/registry/units";
import { AIRSENSE, FLOW, step } from "@airway/edf/airsense";
import type { EdfSignalHeader } from "@airway/edf/header";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";
import { readEdfFile, type EdfFileError, type FileCheck } from "./edf.ts";
import type { PlannedNight } from "./segments.ts";

/** A crossing counts once flow passes this many L/s, in either direction. */
export const BREATH_THRESHOLD = 0.01;
/** Accepted onsets are at least this many samples (1.0 s at 25 Hz) apart. */
export const MIN_BREATH_SAMPLES = 25;
const SAMPLE_MS = 40;

/**
 * Returns the flow smoothed with a centered 5-sample moving average. It averages the digital values
 * and converts the average back to L/s, as the prototype does, so threshold comparisons match the
 * prototype's. Near the ends, the window shrinks to the samples that exist.
 */
export function filterFlow(flow: Float64Array, signal: EdfSignalHeader): Float64Array {
  const physicalMin = Number(signal.physicalMin);
  const physicalRange = Number(signal.physicalMax) - physicalMin;
  const digitalRange = signal.digitalMax - signal.digitalMin;
  const digital = flow.map((value) =>
    Math.round(((value - physicalMin) * digitalRange) / physicalRange + signal.digitalMin),
  );
  const n = digital.length;
  const smoothed = new Float64Array(n);

  for (let i = 0; i < n; i += 1) {
    const lo = Math.max(0, i - 2);
    const hi = Math.min(n - 1, i + 2);
    let sum = 0;

    for (let j = lo; j <= hi; j += 1) {
      sum += digital[j] ?? 0;
    }

    const average = sum / (hi - lo + 1);
    smoothed[i] = ((average - signal.digitalMin) * physicalRange) / digitalRange + physicalMin;
  }

  return smoothed;
}

/** Holds the breaths in one stretch of smoothed flow, as columns. `start` and `duration` count samples. */
export type DetectedBreaths = {
  start: Int32Array;
  duration: Int32Array;
  /** Lists each breath's peak-to-trough flow, in L/s. */
  amplitude: Float64Array;
  /**
   * Lists each breath's inspiratory volume in litres. The volume is the integral of positive flow
   * from the onset to the out-breath's zero crossing.
   */
  inspiratoryVolume: Float64Array;
};

type State = "none" | "in" | "out";

/**
 * Finds the breaths in smoothed flow `f`. An onset is the zero crossing where flow rises from
 * below −0.01 L/s to above +0.01 L/s. Skips an onset that comes less than 1.0 s after the
 * previous accepted onset, so the earlier breath continues through it. A breath ends where the
 * next one starts. Drops the flow before the first onset, and drops the last breath because it has
 * no end.
 */
export function detectBreaths(f: Float64Array): DetectedBreaths {
  const onsets: number[] = [];
  const outOnsets: number[] = [];
  let state: State = "none";
  let lastNonPositive = -1;
  let lastNonNegative = -1;
  // True from an accepted onset until pass 1 finds the zero crossing where that breath's
  // out-breath starts.
  let awaitingOut = false;

  // Pass 1: walk the flow once, tracking whether it last crossed +0.01 L/s (in) or −0.01 L/s (out).
  for (let i = 0; i < f.length; i += 1) {
    const value = f[i] ?? 0;

    // Track the latest sample at or below zero and the latest at or above zero. Pass 1 moves each
    // onset and out-breath start back from its threshold crossing to the zero crossing before it.
    if (value <= 0) {
      lastNonPositive = i;
    }

    if (value >= 0) {
      lastNonNegative = i;
    }

    if (value >= BREATH_THRESHOLD && state !== "in") {
      // Flow rose above +0.01 L/s. The zero crossing before the rise is an onset if flow fell below
      // −0.01 L/s earlier and the crossing is at least 1.0 s after the previous accepted onset. The
      // first condition skips a rise at the start of the file.
      const candidate = lastNonPositive + 1;
      const previous = onsets.at(-1);

      if (
        state === "out" &&
        (previous === undefined || candidate - previous >= MIN_BREATH_SAMPLES)
      ) {
        onsets.push(candidate);
        outOnsets.push(-1);
        awaitingOut = true;
      }

      state = "in";
    } else if (value <= -BREATH_THRESHOLD && state !== "out") {
      // Flow fell below −0.01 L/s. The zero crossing before the first fall after an accepted onset
      // starts that breath's out-breath. Pass 1 ignores later falls in the same breath, including
      // falls after a skipped onset.
      if (state === "in" && awaitingOut) {
        outOnsets[outOnsets.length - 1] = lastNonNegative + 1;
        awaitingOut = false;
      }

      state = "out";
    }
  }

  const count = Math.max(0, onsets.length - 1);
  const breaths: DetectedBreaths = {
    start: new Int32Array(onsets.slice(0, count)),
    duration: new Int32Array(count),
    amplitude: new Float64Array(count),
    inspiratoryVolume: new Float64Array(count),
  };

  // Pass 2: measure each breath, which runs from its onset up to the next breath's onset.
  for (let k = 0; k < count; k += 1) {
    const start = onsets[k] ?? 0;
    const end = onsets[k + 1] ?? start;
    const outStart = outOnsets[k] ?? start;

    // Amplitude is the highest flow minus the lowest flow anywhere in the breath.
    let max = f[start] ?? 0;
    let min = max;

    for (let i = start + 1; i < end; i += 1) {
      const value = f[i] ?? 0;
      max = Math.max(max, value);
      min = Math.min(min, value);
    }

    // Inspiratory volume is the trapezoid-rule integral of flow from the onset to the out-breath's
    // start, with a 40 ms step between samples. Negative flow counts as zero.
    let volume = 0;

    for (let i = start; i < outStart; i += 1) {
      volume += ((Math.max(f[i] ?? 0, 0) + Math.max(f[i + 1] ?? 0, 0)) * (SAMPLE_MS / 1000)) / 2;
    }

    breaths.duration[k] = end - start;
    breaths.amplitude[k] = max - min;
    breaths.inspiratoryVolume[k] = volume;
  }

  return breaths;
}

/**
 * Resolves to one BRP file's breath rows in column-major form. A worker can transfer the arrays to
 * the main thread without copying them. Row `i` is element `i` of each array.
 */
export type BreathBlock = {
  segment: number;
  session: number;
  /** Lists each breath's start in milliseconds since the Unix epoch. */
  ts: Float64Array;
  /** Lists each breath's length in seconds, up to the next breath's start. */
  duration: Float64Array;
  /** Lists each breath's peak-to-trough flow in L/s, rounded to the flow signal's decimals. */
  amplitude: Float64Array;
  /** Lists each breath's inspired volume in litres, rounded to the flow signal's decimals. */
  inspiratory_volume: Float64Array;
};

/** Resolves to a night's breath blocks and the checksum checks of the BRP files they came from. */
export type BreathBlocks = { blocks: BreathBlock[]; checks: FileCheck[] };

/**
 * Returns the breaths in one BRP file's flow as columns, with sample 0 at `start`. Rounds amplitude
 * and volume to the decimals of the flow signal's step.
 */
export function toBreaths(
  flow: Float64Array,
  signal: EdfSignalHeader,
  start: Temporal.Instant,
): Pick<BreathBlock, "ts" | "duration" | "amplitude" | "inspiratory_volume"> {
  const detected = detectBreaths(filterFlow(flow, signal));
  const decimals = decimalsForStep(step(signal));
  const first = start.epochMilliseconds;
  const samplesPerSecond = 1000 / SAMPLE_MS;

  return {
    ts: Float64Array.from(detected.start, (s) => first + s * SAMPLE_MS),
    duration: Float64Array.from(detected.duration, (d) => d / samplesPerSecond),
    amplitude: detected.amplitude.map((value) => round(value, decimals)),
    inspiratory_volume: detected.inspiratoryVolume.map((value) => round(value, decimals)),
  };
}

/**
 * Detects the breaths in each segment's BRP file and returns one `BreathBlock` per file, with each
 * file's checksum checks. Detection never crosses a file boundary. Converts each header's
 * device-clock start time to an instant in `zone`. Runs in an `ingest.breaths` span that records
 * the night, the number of BRP files, and the number of breaths.
 */
export function readBreaths(
  ctx: Pick<AppContext, "config" | "logger">,
  { night, zone, segments }: PlannedNight,
): ResultAsync<BreathBlocks, EdfFileError> {
  return inSpanAsync("ingest.breaths", (span) => {
    span.setAttributes({
      "airway.night": night.toString(),
      "airway.ingest.files": segments.length,
    });

    return ResultAsync.combine(
      segments.map(({ segment, session, brp }) =>
        readEdfFile(ctx, brp.path, AIRSENSE.brp).map(({ file, check }) => {
          const signal = file.signals.find(({ label }) => label === "Flow.40ms");
          const block: BreathBlock = {
            segment,
            session,
            ...toBreaths(
              file.samples["Flow.40ms"],
              signal ?? FLOW,
              toInstant(file.header.start, zone),
            ),
          };

          return { block, check };
        }),
      ),
    ).map((read) => {
      const blocks = read.map(({ block }) => block);

      span.setAttribute(
        "airway.ingest.rows",
        blocks.reduce((sum, { ts }) => sum + ts.length, 0),
      );

      return { blocks, checks: read.map(({ check }) => check) };
    });
  });
}
