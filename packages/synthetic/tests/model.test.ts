import { describe, expect, it } from "vitest";
import { AIRSENSE, step, type EdfFileType } from "@airway/edf/airsense";
import { syntheticNights, type NightStrLabel, type SyntheticNight } from "../src/model.ts";

const { nights } = syntheticNights({ seed: 7, nights: 30 })._unsafeUnwrap();
const { nights: adults } = syntheticNights({
  seed: 7,
  nights: 30,
  patient: "adult",
})._unsafeUnwrap();

const seconds = (from: Temporal.Instant, to: Temporal.Instant): number =>
  from.until(to).total("seconds");

function onStep(file: EdfFileType, label: string, value: number): boolean {
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
  it("returns the same nights for the same seed and different nights for a different seed", () => {
    expect(syntheticNights({ seed: 7, nights: 30 })._unsafeUnwrap().nights).toEqual(nights);
    expect(syntheticNights({ seed: 8, nights: 30 })._unsafeUnwrap().nights).not.toEqual(nights);
  });

  it("starts each night's EVE file 3 to 35 s before the night's first segment", () => {
    for (const night of nights) {
      const [file] = night.eventFiles;
      const lead = seconds(
        file?.start ?? night.night.toZonedDateTime("UTC").toInstant(),
        night.segments[0]?.start ?? Temporal.Instant.fromEpochMilliseconds(0),
      );

      expect(night.eventFiles).toHaveLength(1);
      expect(lead).toBeGreaterThanOrEqual(3);
      expect(lead).toBeLessThanOrEqual(35);
    }
  });

  it("dates consecutive nights one day apart", () => {
    expect(nights.map((night) => night.night.toString()).slice(0, 2)).toEqual([
      "2030-01-07",
      "2030-01-08",
    ]);
  });

  it.each(nights.map((night) => [night.night.toString(), night] as const))(
    "%s scores AHI with the integer formula and counts two mask events per session",
    (_date, night) => {
      const usage = night.str["OnDuration"];
      const tenths = (n: number): number => Math.floor((600 * n) / usage) / 10;
      const apneas = counts(night, "obstructive_apnea", "central_apnea", "unclassified_apnea");

      expect(night.str["AHI"]).toBeCloseTo(tenths(apneas + counts(night, "hypopnea")), 9);
      expect(night.str["OAI"]).toBeCloseTo(tenths(counts(night, "obstructive_apnea")), 9);
      expect(night.str["MaskEvents"]).toBe(2 * night.periods.length);
    },
  );

  it("makes every value a whole number of steps above its signal's minimum", () => {
    for (const night of nights) {
      for (const [label, value] of Object.entries(night.str)) {
        expect(onStep(AIRSENSE.str, label, value), label).toBe(true);
      }

      for (const segment of night.segments) {
        for (const [label, values] of Object.entries(segment.pldSeries)) {
          expect(
            values.every((value) => onStep(AIRSENSE.pld, label, value)),
            label,
          ).toBe(true);
        }
      }
    }
  });

  // A pause that starts earlier would compress the segment's first breaths into a spike.
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

  it("makes every segment a whole number of minutes long and keeps every episode inside a single segment", () => {
    for (const night of nights) {
      for (const segment of night.segments) {
        expect(seconds(segment.start, segment.end) % 60).toBe(0);
        expect(segment.pldSeries["Leak.2s"]).toHaveLength(seconds(segment.start, segment.end) / 2);
      }

      for (const { at, duration } of [...night.events, ...night.pauses]) {
        const inside = night.segments.some(
          ({ start, end }) => seconds(start, at) > 0 && seconds(at, end) > duration,
        );

        expect(inside).toBe(true);
      }
    }
  });

  it("keeps each pause's duration within the range for its kind", () => {
    for (const night of nights) {
      const breath = 60 / night.str["RespRate.50"];

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

  it("computes the medians and leak percentiles from the 2 s samples", () => {
    const [night] = nights;
    const leak = night?.segments.flatMap((segment) => [...segment.pldSeries["Leak.2s"]]);

    expect(night?.str["Leak.50"]).toBeCloseTo(median(leak ?? []), 1);
  });

  it("generates a short night, a high-AHI night, and every kind of pause within 30 nights", () => {
    const usage = nights.map((night) => night.str["OnDuration"]);
    const ahi = nights.map((night) => night.str["AHI"]);
    const kinds = new Set(nights.flatMap((night) => night.pauses.map((pause) => pause.kind)));

    expect(Math.min(...usage)).toBeLessThan(300);
    expect(Math.max(...ahi)).toBeGreaterThan(2 * median(ahi));
    expect(kinds).toEqual(new Set(["machine_apnea", "pediatric", "dip"]));
  });

  describe("mask-on periods", () => {
    const children = syntheticNights({ seed: 3, nights: 120 })._unsafeUnwrap().nights;
    const grownUps = syntheticNights({ seed: 3, nights: 120, patient: "adult" })._unsafeUnwrap()
      .nights;

    // Returns the seconds between consecutive BRP files inside each period.
    const gaps = (list: SyntheticNight[]): number[] =>
      list.flatMap((night) =>
        night.periods.flatMap(({ on, off }) => {
          const inside = night.segments.filter(
            ({ start, end }) => seconds(on, start) >= 0 && seconds(end, off) >= 0,
          );

          return inside.slice(1).map((segment, i) => seconds(inside[i]?.end ?? on, segment.start));
        }),
      );
    const breaks = (list: SyntheticNight[]): number[] =>
      list.flatMap((night) =>
        night.periods
          .slice(1)
          .map((period, i) => seconds(night.periods[i]?.off ?? period.on, period.on)),
      );

    it("generates 1 to 20 periods a night for a child, and on some nights more than STR.edf's 10 slots", () => {
      const counts = children.map((night) => night.periods.length);

      expect(Math.min(...counts)).toBeGreaterThanOrEqual(1);
      expect(Math.max(...counts)).toBeLessThanOrEqual(20);
      expect(counts.some((count) => count > 10)).toBe(true);
    });

    it("makes some of a child's file gaps longer than the 90 s gap that ingest joins across, and some shorter", () => {
      const all = gaps(children);

      expect(Math.min(...all)).toBeGreaterThanOrEqual(5);
      expect(Math.max(...all)).toBeLessThanOrEqual(120);
      expect(all.some((gap) => gap > 90)).toBe(true);
      expect(all.some((gap) => gap <= 90)).toBe(true);
    });

    it("generates 1 to 6 periods a night for an adult, with file gaps of 90 s or less", () => {
      const counts = grownUps.map((night) => night.periods.length);

      expect(Math.max(...counts)).toBeLessThanOrEqual(6);
      expect(Math.max(...gaps(grownUps))).toBeLessThanOrEqual(90);
      expect(Math.min(...gaps(grownUps))).toBeGreaterThanOrEqual(5);
    });

    it("makes every break between periods last between 60 s and 3 hours", () => {
      const all = [...breaks(children), ...breaks(grownUps)];

      expect(Math.min(...all)).toBeGreaterThanOrEqual(60);
      expect(Math.max(...all)).toBeLessThanOrEqual(3 * 3600);
    });

    // A night that ran past noon would put its last files in the next night's folder.
    it("ends every night by 11:00 on the device clock", () => {
      // Seed 1's 31st night ends near the deadline. The device clock runs at Chicago's winter
      // offset, UTC-6.
      const { nights: late } = syntheticNights({ seed: 1, nights: 31 })._unsafeUnwrap();

      for (const night of [...children, ...grownUps, ...late]) {
        const last = night.periods.at(-1)?.off;
        const deadline = night.night
          .add({ days: 1 })
          .toZonedDateTime({ timeZone: "-06:00", plainTime: "11:00" })
          .toInstant();

        expect(last === undefined ? 0 : seconds(last, deadline)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  it("generates a slower respiratory rate and a larger tidal volume for an adult than for a child", () => {
    const mid = (list: SyntheticNight[], label: NightStrLabel): number =>
      median(list.map((night) => night.str[label]));

    expect(mid(adults, "RespRate.50")).toBeLessThan(mid(nights, "RespRate.50"));
    expect(mid(adults, "TidVol.50")).toBeGreaterThan(mid(nights, "TidVol.50"));
  });
});
