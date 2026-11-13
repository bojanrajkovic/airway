import { describe, expect, it } from "vitest";
import { AIRSENSE, step } from "../../src/edf/airsense.ts";
import { nights } from "../../src/registry/nights.ts";
import { samples } from "../../src/registry/samples.ts";

const metricsOf = (columns: readonly { name: string; role: string }[]): Set<string> =>
  new Set(columns.filter((column) => column.role === "metric").map((column) => column.name));

const DATASET_METRICS = { samples: metricsOf(samples.columns), nights: metricsOf(nights.columns) };

const targets = Object.values(AIRSENSE).flatMap((file) =>
  file.signals.flatMap(({ label, target }) =>
    target.table === "samples" || target.table === "nights"
      ? [[label, target.table, target.column] as const]
      : [],
  ),
);

describe("AIRSENSE", () => {
  it.each(targets)("%s fills a %s metric named %s", (_label, table, column) => {
    expect(DATASET_METRICS[table]).toContain(column);
  });

  it("fills every samples signal from PLD", () => {
    const filled = targets.filter(([, table]) => table === "samples").map(([, , column]) => column);

    expect(new Set(filled)).toEqual(DATASET_METRICS.samples);
  });

  it("lists STR.edf's 81 signals", () => {
    expect(AIRSENSE.str.signals).toHaveLength(81);
  });

  it.each([
    ["Flow.40ms", AIRSENSE.brp, 0.002],
    ["Press.40ms", AIRSENSE.brp, 0.02],
    ["Leak.2s", AIRSENSE.pld, 0.02],
    ["AHI", AIRSENSE.str, 0.1],
    ["S.EPR.Level", AIRSENSE.str, 0.02],
  ])("%s has a step of %s", (label, file, expected) => {
    const signal = file.signals.find((s) => s.label === label);

    expect(signal === undefined ? Number.NaN : step(signal)).toBeCloseTo(expected, 9);
  });
});
