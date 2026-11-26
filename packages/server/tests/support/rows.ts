import type { BreathRow, SampleRow } from "@airway/contract/derived/rows";
import { PLD_SAMPLE_COLUMNS } from "@airway/edf/columns";
import type { BreathBlock } from "../../src/ingest/breaths.ts";
import type { SampleBlock } from "../../src/ingest/samples.ts";

/** Converts sample blocks to the `SampleRow`s that `synthesize` returns, replacing NaN with null. */
export function toSampleRows(
  night: Temporal.PlainDate,
  blocks: readonly SampleBlock[],
): SampleRow[] {
  return blocks.flatMap(({ segment, session, ts, signals }) =>
    [...ts].map((ms, i): SampleRow => ({
      night,
      segment,
      session,
      ts: Temporal.Instant.fromEpochMilliseconds(ms),
      signals: Object.fromEntries(
        PLD_SAMPLE_COLUMNS.map(([, column]) => {
          const value = signals[column][i] ?? Number.NaN;

          return [column, Number.isNaN(value) ? null : value];
        }),
      ),
    })),
  );
}

/** Converts breath blocks to the `BreathRow`s that `synthesize` returns. */
export function toBreathRows(
  night: Temporal.PlainDate,
  blocks: readonly BreathBlock[],
): BreathRow[] {
  return blocks.flatMap(({ segment, session, ts, duration, amplitude, inspiratory_volume }) =>
    [...ts].map((ms, i): BreathRow => ({
      night,
      segment,
      session,
      ts: Temporal.Instant.fromEpochMilliseconds(ms),
      duration: duration[i] ?? Number.NaN,
      amplitude: amplitude[i] ?? Number.NaN,
      inspiratory_volume: inspiratory_volume[i] ?? Number.NaN,
    })),
  );
}
