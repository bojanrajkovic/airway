import { describe, expect, it } from "vitest";
import { AIRSENSE, nightFileType, step } from "../src/airsense.ts";

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

describe("nightFileType", () => {
  it.each([
    ["20300107_213412_BRP.edf", { type: "brp", crc: false }],
    ["20300107_213413_PLD.crc", { type: "pld", crc: true }],
    ["20300107_213413_SAD.edf", { type: "sad", crc: false }],
    ["20300107_213412_EVE.crc", { type: "eve", crc: true }],
    ["20300107_213412_CSL.edf", { type: "csl", crc: false }],
  ])("reads the type of %s and whether it's a .crc file", (name, expected) => {
    expect(nightFileType(name)).toEqual(expected);
  });

  it.each(["STR.edf", "Identification.crc", "20300107_213412_BRP.txt", "notes_BRP.edf.bak"])(
    "returns undefined for %s",
    (name) => {
      expect(nightFileType(name)).toBeUndefined();
    },
  );
});
