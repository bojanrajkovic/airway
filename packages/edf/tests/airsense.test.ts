import { describe, expect, it } from "vitest";
import { AIRSENSE, step } from "../src/airsense.ts";

describe("AIRSENSE", () => {
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
