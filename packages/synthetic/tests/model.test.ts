import { describe, expect, it } from "vitest";
import { AIRSENSE, step, type EdfFile } from "@airway/contract/edf/airsense";
import { syntheticNights, type SyntheticNight } from "../src/model.ts";

const nights = syntheticNights({ seed: 7, nights: 30 });
const adults = syntheticNights({ seed: 7, nights: 30, patient: "adult" });

const seconds = (from: Temporal.Instant, to: Temporal.Instant): number =>
  from.until(to).total("seconds");

function onStep(file: EdfFile, label: string, value: number): boolean {
  const signal = file.signals.find((s) => s.label === label);

  if (signal === undefined || Number.isNaN(value)) {
    return true;
  }

  const steps = (value - Number(signal.physicalMin)) / step(signal);

  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

const counts = (night: SyntheticNight, ...types: string[]): number =>
  night.events.filter((event) => types.includes(event.type)).length;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

describe("syntheticNights", () => {
  it("gives the same nights for the same seed, and different ones for another", () => {
    expect(syntheticNights({ seed: 7, nights: 30 })).toEqual(nights);
    expect(syntheticNights({ seed: 8, nights: 30 })).not.toEqual(nights);
  });

  it("starts each night on its own date, in order", () => {
    expect(nights.map((night) => night.night.toString()).slice(0, 2)).toEqual([
      "2030-01-07",
      "2030-01-08",
    ]);
  });

  it.each(nights.map((night) => [night.night.toString(), night] as const))(
    "%s scores AHI with the integer formula and counts two mask events per session",
    (_date, night) => {
      const usage = night.str.get("OnDuration") ?? 0;
      const tenths = (n: number): number => Math.floor((600 * n) / usage) / 10;
      const apneas = counts(night, "obstructive_apnea", "central_apnea", "unclassified_apnea");

      expect(night.str.get("AHI")).toBeCloseTo(tenths(apneas + counts(night, "hypopnea")), 9);
      expect(night.str.get("OAI")).toBeCloseTo(tenths(counts(night, "obstructive_apnea")), 9);
      expect(night.str.get("MaskEvents")).toBe(2 * night.periods.length);
    },
  );

  it("fills every STR.edf signal except the ones the clock or file decides", () => {
    const expected = AIRSENSE.str.signals
      .map((signal) => signal.label)
      .filter((label) => !["Date", "MaskOn", "MaskOff", "Crc16"].includes(label));

    for (const night of nights) {
      expect(new Set(night.str.keys())).toEqual(new Set(expected));
    }
  });

  it("puts every value on its signal's step", () => {
    for (const night of nights) {
      for (const [label, value] of night.str) {
        expect(onStep(AIRSENSE.str, label, value), label).toBe(true);
      }

      for (const segment of night.segments) {
        for (const [label, values] of segment.pld) {
          expect(
            values.every((value) => onStep(AIRSENSE.pld, label, value)),
            label,
          ).toBe(true);
        }
      }
    }
  });

  // A segment's first breaths need room before any pause, so none is squeezed into a spike.
  it("starts every episode at least 10 s into its segment", () => {
    for (const night of nights) {
      for (const { at } of [...night.events, ...night.pauses]) {
        const segment = night.segments.find(
          ({ start, end }) => seconds(start, at) >= 0 && seconds(at, end) > 0,
        );

        expect(segment === undefined ? -1 : seconds(segment.start, at)).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it("makes segments whole minutes and keeps every episode inside one", () => {
    for (const night of nights) {
      for (const segment of night.segments) {
        expect(seconds(segment.start, segment.end) % 60).toBe(0);
        expect(segment.pld.get("Leak.2s")).toHaveLength(seconds(segment.start, segment.end) / 2);
      }

      for (const { at, duration } of [...night.events, ...night.pauses]) {
        const inside = night.segments.some(
          ({ start, end }) => seconds(start, at) > 0 && seconds(at, end) > duration,
        );

        expect(inside).toBe(true);
      }
    }
  });

  it("makes pauses the length their kind promises", () => {
    for (const night of nights) {
      const breath = 60 / (night.str.get("RespRate.50") ?? 1);

      for (const pause of night.pauses) {
        if (pause.kind === "machine_apnea") {
          expect(pause.duration).toBeGreaterThanOrEqual(10);
        } else if (pause.kind === "pediatric") {
          expect(pause.duration).toBeLessThan(10);
          expect(pause.duration).toBeGreaterThanOrEqual(2 * breath);
        } else {
          expect(pause.duration).toBeLessThan(2 * breath);
        }
      }
    }
  });

  it("takes the medians and leak percentiles from the 2 s data", () => {
    const [night] = nights;
    const leak = night?.segments.flatMap((segment) => [...(segment.pld.get("Leak.2s") ?? [])]);

    expect(night?.str.get("Leak.50")).toBeCloseTo(median(leak ?? []), 1);
  });

  it("has short nights, bad nights, and every kind of pause across a month", () => {
    const usage = nights.map((night) => night.str.get("OnDuration") ?? 0);
    const ahi = nights.map((night) => night.str.get("AHI") ?? 0);
    const kinds = new Set(nights.flatMap((night) => night.pauses.map((pause) => pause.kind)));

    expect(Math.min(...usage)).toBeLessThan(300);
    expect(Math.max(...ahi)).toBeGreaterThan(2 * median(ahi));
    expect(kinds).toEqual(new Set(["machine_apnea", "pediatric", "dip"]));
  });

  it("breathes slower and deeper for an adult", () => {
    const mid = (list: SyntheticNight[], label: string): number =>
      median(list.map((night) => night.str.get(label) ?? 0));

    expect(mid(adults, "RespRate.50")).toBeLessThan(mid(nights, "RespRate.50"));
    expect(mid(adults, "TidVol.50")).toBeGreaterThan(mid(nights, "TidVol.50"));
  });
});
