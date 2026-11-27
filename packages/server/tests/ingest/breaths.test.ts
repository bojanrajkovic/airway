import { describe, expect, it } from "vitest";
import type { BreathRow } from "@airway/contract/derived/rows";
import { FLOW } from "@airway/edf/airsense";
import { EdgeCaseName } from "@airway/synthetic/cases";
import {
  BREATH_THRESHOLD,
  detectBreaths,
  filterFlow,
  readBreaths,
} from "../../src/ingest/breaths.ts";
import { folderContext, synthesizedNights, writeFolder } from "../support/cpap-folder.ts";
import { toBreathRows } from "../support/rows.ts";

const HZ = 25;

// Returns `seconds` of flow at 25 Hz, where `at(t)` gives the flow t seconds in.
const flowOf = (seconds: number, at: (t: number) => number): Float64Array =>
  Float64Array.from({ length: seconds * HZ }, (_, i) => at(i / HZ));

// A sine with a 3 s period: breathing in for 1.5 s, then out for 1.5 s. The 0.02 s shift keeps
// each zero crossing between two samples, so float error can't move an onset.
const sine = (t: number): number => 0.3 * Math.sin((2 * Math.PI * (t + 0.02)) / 3);

describe("detectBreaths", () => {
  it("finds one breath per period, leaving out the first and the last", () => {
    // 20 periods: the first in-breath has no out-breath before it, and the last breath has no end.
    const breaths = detectBreaths(flowOf(60, sine));

    expect(breaths.start).toHaveLength(18);
    expect([...breaths.duration]).toEqual(Array.from({ length: 18 }, () => 75));
    expect(breaths.start[0]).toBe(75);
  });

  it("measures a sine breath's peak to trough and its in-breath volume", () => {
    const breaths = detectBreaths(flowOf(12, sine));

    expect(breaths.amplitude[0]).toBeCloseTo(0.6, 3);
    // The area under a half sine of height 0.3 over 1.5 s is 2 × 0.3 × 1.5 / π.
    expect(breaths.inspiratoryVolume[0]).toBeCloseTo((2 * 0.3 * 1.5) / Math.PI, 2);
  });

  it("keeps a breath whole when flow dips below zero for less than 1.0 s", () => {
    // A 0.4 s dip to -0.05 L/s in the middle of an in-breath crosses both thresholds. A dip in
    // the first in-breath would add an onset, because no earlier onset falls within 1.0 s of it. So
    // the dips start in the second in-breath.
    const dipped = (t: number): number => {
      const phase = t % 3;

      return t > 3 && phase > 0.5 && phase < 0.9 ? -0.05 : sine(t);
    };

    expect(detectBreaths(flowOf(60, dipped)).start).toHaveLength(18);
  });

  it("counts flow of exactly the threshold as a crossing", () => {
    const square = (t: number): number => (t % 3 < 1.5 ? BREATH_THRESHOLD : -BREATH_THRESHOLD);

    expect(detectBreaths(flowOf(60, square)).start).toHaveLength(18);
  });

  it("finds no breaths in flow that stays inside the thresholds", () => {
    expect(detectBreaths(flowOf(60, (t) => 0.005 * Math.sin(t))).start).toHaveLength(0);
  });
});

describe("filterFlow", () => {
  it("averages five samples, and fewer at the ends", () => {
    // FLOW's step is 0.002 L/s, so these are digital values 0, 5, 10, 15, 20, 25.
    const flow = Float64Array.from([0, 0.01, 0.02, 0.03, 0.04, 0.05]);
    const smoothed = filterFlow(flow, FLOW);

    expect(smoothed[0]).toBeCloseTo(0.01, 9);
    expect(smoothed[2]).toBeCloseTo(0.02, 9);
    expect(smoothed[5]).toBeCloseTo(0.04, 9);
  });
});

const median = (values: readonly number[]): number =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

// Compares detected breaths with synthesize's rows. detectBreaths puts an onset just after the
// last sample of smoothed flow at or below zero. After a pause, smoothed noise can stay just above
// zero for a few samples, so an onset can come up to about 0.55 s early. Smoothing also lowers a
// half sine's peak, most for the short breaths before a pause.
function expectNear(actual: readonly BreathRow[], expected: readonly BreathRow[]): void {
  expect(actual).toHaveLength(expected.length);

  const pairs = actual.map((row, i) => ({ row, want: expected[i] }));
  const ratio = (field: "amplitude" | "inspiratory_volume"): number[] =>
    pairs.map(({ row, want }) => row[field] / (want?.[field] ?? Number.NaN));

  for (const { row, want } of pairs) {
    expect({ segment: row.segment, session: row.session }).toEqual({
      segment: want?.segment,
      session: want?.session,
    });
    expect(
      Math.abs(row.ts.epochMilliseconds - (want?.ts.epochMilliseconds ?? Number.NaN)),
    ).toBeLessThanOrEqual(600);
  }

  for (const field of ["amplitude", "inspiratory_volume"] as const) {
    expect(median(ratio(field))).toBeGreaterThan(0.98);
    expect(Math.min(...ratio(field))).toBeGreaterThan(0.8);
    expect(Math.max(...ratio(field))).toBeLessThan(1.01);
  }
}

describe("readBreaths", () => {
  it.each<[string, EdgeCaseName[], number]>([
    ["plain nights", [], 2],
    ["a night with many mask-on periods", [EdgeCaseName.ManyPeriods], 0],
  ])("matches synthesize's breath rows for %s", async (_, cases, nights) => {
    const { planned, files, rows } = synthesizedNights(cases, nights);
    const ctx = folderContext(await writeFolder(files));

    for (const plan of planned) {
      const { blocks } = (await readBreaths(ctx, plan))._unsafeUnwrap();

      expectNear(
        toBreathRows(plan.night, blocks),
        rows.breaths.filter((row) => row.night.equals(plan.night)),
      );
    }
  });

  it("returns a read_failed error with the path of a missing BRP file", async () => {
    const { planned, files } = synthesizedNights([], 1);
    const [first] = planned;
    const brp = first?.segments[0]?.brp.path;

    if (first === undefined || brp === undefined) {
      throw new Error("expected a night with a BRP file");
    }

    const ctx = folderContext(await writeFolder(files.filter(({ path }) => path !== brp)));

    expect((await readBreaths(ctx, first))._unsafeUnwrapErr()).toMatchObject({
      kind: "read_failed",
      path: brp,
    });
  });
});
