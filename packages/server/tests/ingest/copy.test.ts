import { describe, expect, it } from "vitest";
import { PLD_SAMPLE_COLUMNS } from "@airway/edf/columns";
import type { BreathBlock } from "../../src/ingest/breaths.ts";
import { breathLines, sampleLines, SAMPLE_COLUMNS } from "../../src/ingest/copy.ts";
import type { SampleBlock, SampleColumn } from "../../src/ingest/samples.ts";

const night = Temporal.PlainDate.from("2030-01-07");
const ts = Float64Array.of(Date.parse("2030-01-08T02:00:00Z"), Date.parse("2030-01-08T02:00:02Z"));

describe("sampleLines", () => {
  it("writes one tab-separated line per row in SAMPLE_COLUMNS order, with NaN as \\N", () => {
    const column = (i: number): Float64Array => Float64Array.of(i + 0.4, Number.NaN);
    const signals: Record<SampleColumn, Float64Array> = {
      mask_pressure: column(0),
      pressure: column(1),
      epr_pressure: column(2),
      leak: column(3),
      respiratory_rate: column(4),
      tidal_volume: column(5),
      minute_ventilation: column(6),
      snore: column(7),
      flow_limitation: column(8),
    };
    const block: SampleBlock = { segment: 2, session: 1, ts, signals };
    const lines = [...sampleLines(night, block)].map((line) => line.trimEnd().split("\t"));

    expect(lines.map((fields) => fields.length)).toEqual([
      SAMPLE_COLUMNS.length,
      SAMPLE_COLUMNS.length,
    ]);
    expect(lines[0]?.slice(0, 5)).toEqual([
      "2030-01-07",
      "2",
      "1",
      "2030-01-08T02:00:00.000Z",
      "0.4",
    ]);
    expect(lines[1]?.slice(4)).toEqual(PLD_SAMPLE_COLUMNS.map(() => "\\N"));
  });
});

describe("breathLines", () => {
  it("writes each breath's time, duration, amplitude, and volume", () => {
    const block: BreathBlock = {
      segment: 1,
      session: 1,
      ts: ts.subarray(0, 1),
      duration: Float64Array.of(3.2),
      amplitude: Float64Array.of(0.62),
      inspiratory_volume: Float64Array.of(0.31),
    };

    expect([...breathLines(night, block)]).toEqual([
      "2030-01-07\t1\t1\t2030-01-08T02:00:00.000Z\t3.2\t0.62\t0.31\n",
    ]);
  });
});
