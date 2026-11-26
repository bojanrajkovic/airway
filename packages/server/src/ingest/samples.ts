// Reads each night's PLD files into columns for the samples table.
import { ResultAsync } from "neverthrow";
import { toInstant } from "@airway/contract/clock";
import { decimalsForStep, round } from "@airway/contract/registry/units";
import { AIRSENSE, PLD_SAMPLE_SECONDS, step, type DataLabel } from "@airway/edf/airsense";
import { PLD_SAMPLE_COLUMNS } from "@airway/edf/columns";
import type { EdfSignalFile } from "@airway/edf/file";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";
import { readEdfFile, type EdfFileError } from "./edf.ts";
import type { PlannedNight } from "./segments.ts";

/** Names a column of the samples table that holds a PLD signal. */
export type SampleColumn = (typeof PLD_SAMPLE_COLUMNS)[number][1];

type PldLabel = DataLabel<typeof AIRSENSE.pld>;

/**
 * Resolves to one PLD file's sample rows in column-major form. A worker can transfer the arrays to
 * the main thread without copying them. Row `i` is element `i` of each array.
 */
export type SampleBlock = {
  segment: number;
  session: number;
  /** Lists each sample's time in milliseconds since the Unix epoch, `PLD_SAMPLE_SECONDS` apart. */
  ts: Float64Array;
  /**
   * Maps each samples column to its values, rounded to the signal's step. NaN marks a value that
   * the machine didn't record.
   */
  signals: Record<SampleColumn, Float64Array>;
};

/**
 * Returns one PLD file's samples as columns, with the first row at `start`. Rounds each signal's
 * values in place to the step in that signal's header.
 */
export function toSamples(
  file: EdfSignalFile<PldLabel>,
  start: Temporal.Instant,
): Pick<SampleBlock, "ts" | "signals"> {
  const headers = new Map(file.signals.map((signal) => [signal.label, signal]));
  const rounded = (label: PldLabel): Float64Array => {
    const values = file.samples[label];
    const header = headers.get(label);
    const decimals = header === undefined ? 0 : decimalsForStep(step(header));

    for (let i = 0; i < values.length; i += 1) {
      values[i] = round(values[i] ?? Number.NaN, decimals);
    }

    return values;
  };

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PLD_SAMPLE_COLUMNS lists every SampleColumn, but Object.fromEntries types its keys as string
  const signals = Object.fromEntries(
    PLD_SAMPLE_COLUMNS.map(([label, column]) => [column, rounded(label)]),
  ) as Record<SampleColumn, Float64Array>;

  const count = file.samples["MaskPress.2s"].length;
  const ts = new Float64Array(count);
  const first = start.epochMilliseconds;

  for (let i = 0; i < count; i += 1) {
    ts[i] = first + i * PLD_SAMPLE_SECONDS * 1000;
  }

  return { ts, signals };
}

/**
 * Reads every PLD file attached to the night's segments and returns one `SampleBlock` per file.
 * Converts each header's device-clock start time to an instant in `zone`. Runs in an
 * `ingest.samples` span that records the night, the number of PLD files, and the number of rows.
 */
export function readSamples(
  ctx: Pick<AppContext, "config">,
  { night, zone, segments }: PlannedNight,
): ResultAsync<SampleBlock[], EdfFileError> {
  const plds = segments.flatMap(({ segment, session, plds }) =>
    plds.map((file) => ({ segment, session, path: file.path })),
  );

  return inSpanAsync("ingest.samples", (span) => {
    span.setAttributes({ "airway.night": night.toString(), "airway.ingest.files": plds.length });

    return ResultAsync.combine(
      plds.map(({ segment, session, path }) =>
        readEdfFile(ctx, path, AIRSENSE.pld).map((file): SampleBlock => ({
          segment,
          session,
          ...toSamples(file, toInstant(file.header.start, zone)),
        })),
      ),
    ).map((blocks) => {
      span.setAttribute(
        "airway.ingest.rows",
        blocks.reduce((sum, { ts }) => sum + ts.length, 0),
      );

      return blocks;
    });
  });
}
