import type { SampleRow } from "@airway/contract/derived/rows";
import { PLD_SAMPLE_COLUMNS } from "@airway/edf/columns";
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
