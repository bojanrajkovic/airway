// Encodes a night's sample and breath blocks as COPY text.
import { PLD_SAMPLE_COLUMNS } from "@airway/edf/columns";
import type { BreathBlock } from "./breaths.ts";
import type { SampleBlock } from "./samples.ts";

/** Lists the samples table's columns in the order that `sampleLines` writes them. */
export const SAMPLE_COLUMNS = [
  "night",
  "segment",
  "session",
  "ts",
  ...PLD_SAMPLE_COLUMNS.map(([, column]) => column),
] as const;

/** Lists the breaths table's columns in the order that `breathLines` writes them. */
export const BREATH_COLUMNS = [
  "night",
  "segment",
  "session",
  "ts",
  "duration",
  "amplitude",
  "inspiratory_volume",
] as const;

// The worker already rounded each value to its signal's step, so the shortest decimal that
// round-trips is the stored value.
const value = (n: number | undefined): string =>
  n === undefined || Number.isNaN(n) ? "\\N" : String(n);

const key = (night: Temporal.PlainDate, block: SampleBlock | BreathBlock, ts: number): string =>
  `${night.toString()}\t${block.segment.toString()}\t${block.session.toString()}\t${new Date(ts).toISOString()}`;

/** Yields one COPY line for each row of a sample block, in `SAMPLE_COLUMNS` order. Writes NaN as `\N`. */
export function* sampleLines(night: Temporal.PlainDate, block: SampleBlock): Generator<string> {
  const columns = PLD_SAMPLE_COLUMNS.map(([, column]) => block.signals[column]);

  for (const [i, ts] of block.ts.entries()) {
    yield `${key(night, block, ts)}\t${columns.map((column) => value(column[i])).join("\t")}\n`;
  }
}

/** Yields one COPY line for each row of a breath block, in `BREATH_COLUMNS` order. Writes NaN as `\N`. */
export function* breathLines(night: Temporal.PlainDate, block: BreathBlock): Generator<string> {
  for (const [i, ts] of block.ts.entries()) {
    yield `${key(night, block, ts)}\t${value(block.duration[i])}\t${value(block.amplitude[i])}\t${value(block.inspiratory_volume[i])}\n`;
  }
}
