import { describe, expect, it } from "vitest";
import { FileKind } from "@airway/contract/derived/values";
import { EdgeCaseName, edgeCaseNames } from "../src/cases.ts";
import { Patient } from "../src/patients.ts";
import { annotationsOf } from "./edf.ts";
import { maskSlots, nightFiles, sizeCheck, type MaskSlots, type NightFile } from "../src/files.ts";
import { syntheticNights, type Synthetic, type SyntheticNight } from "../src/model.ts";
import { synthesize, type Synthesized } from "../src/synthesize.ts";

const arrivedAt = Temporal.Instant.from("2030-03-01T12:00:00Z");

type Built = Synthetic & Synthesized & { night: SyntheticNight };

function edgeCase(name: EdgeCaseName, zone = "America/Chicago"): Built {
  const model = syntheticNights({ seed: 7, nights: 0, cases: [name], zone })._unsafeUnwrap();
  const [night] = model.nights;

  if (night === undefined) {
    throw new Error(`${name} built no nights`);
  }

  const synthesized = synthesize(model.nights, model.zone, {
    patient: Patient.Child,
    arrivedAt,
  })._unsafeUnwrap();

  return { ...model, ...synthesized, night };
}

const slots = (night: SyntheticNight): MaskSlots => maskSlots(night, "America/Chicago");

describe("edge cases", () => {
  it("leave the base nights unchanged", () => {
    const base = syntheticNights({ seed: 7, nights: 3 })._unsafeUnwrap();
    const withCases = syntheticNights({ seed: 7, nights: 3, cases: "all" })._unsafeUnwrap();

    expect(withCases.nights.slice(0, 3)).toEqual(base.nights);
    expect(withCases.nights.length).toBeGreaterThan(3);
  });

  it("follow the base nights in date order, each case starting the day after the last", () => {
    const { nights } = syntheticNights({ seed: 7, nights: 2, cases: "all" })._unsafeUnwrap();
    const gaps = nights.slice(1).map((night, i) => nights[i]?.night.until(night.night).days);

    // Only unused-days leaves a gap: its two nights are 3 days apart.
    expect(gaps.filter((days) => days !== 1)).toEqual([3]);
  });

  describe("many-periods", () => {
    const { night, rows } = edgeCase(EdgeCaseName.ManyPeriods);

    it("has 10 slot sessions and 3 derived sessions, and the total matches MaskEvents", () => {
      expect(night.periods).toHaveLength(13);
      expect(rows.sessions.map(({ source }) => source)).toEqual([
        ...Array.from({ length: 10 }, () => "str"),
        "derived",
        "derived",
        "derived",
      ]);
      expect(rows.nights[0]?.session_count_approximate).toBe(false);
    });

    it("joins files 90 s apart and splits periods 91 s apart", () => {
      const sessionOf = rows.segments.map(({ session }) => session);

      // Segments 11 and 12 are period 11's two files; 13 and 14 are periods 12 and 13.
      expect(sessionOf.slice(10)).toEqual([11, 11, 12, 13]);
    });

    it("puts a file within 60 s of two slots in the slot that the file overlaps most", () => {
      expect(rows.segments[4]?.session).toBe(5);
    });

    it("keeps events 45 s before a period inside the period, and marks events 120 s after a period as outside", () => {
      const outside = rows.events.filter((event) => event.outside_mask_on);

      expect(outside).toHaveLength(11);
      for (const event of outside) {
        expect(event.type).toBe("hypopnea");
      }
    });
  });

  describe("noon-edge", () => {
    const { night, rows } = edgeCase(EdgeCaseName.NoonEdge);

    it("leaves slot 0 without a mask-on", () => {
      expect(slots(night).maskOn[0]).toBeNaN();
      expect(slots(night).maskOff[0]).toBe(40);
    });

    it("starts the first session at noon on the device clock", () => {
      expect(rows.sessions[0]?.ts).toEqual(
        Temporal.Instant.from(`${night.night.toString()}T12:00:00-06:00`),
      );
      expect(rows.segments[0]?.session).toBe(1);
    });
  });

  describe("sub-minute-period", () => {
    const { night, rows } = edgeCase(EdgeCaseName.SubMinutePeriod);

    it("records the pair's mask-on and mask-off in the same minute, with no BRP file", () => {
      const { maskOn, maskOff } = slots(night);

      expect(maskOn[1]).toBe(maskOff[1]);
      expect(night.segments).toHaveLength(2);
    });

    it("skips the pair when making sessions, so the session count is one short of MaskEvents", () => {
      expect(rows.sessions).toHaveLength(2);
      expect(rows.nights[0]?.expected_sessions).toBe(3);
      expect(rows.nights[0]?.session_count_approximate).toBe(true);
    });
  });

  describe("folderless-day", () => {
    const { night, files, rows } = edgeCase(EdgeCaseName.FolderlessDay);

    it("records the day's usage in STR.edf, with no DATALOG folder", () => {
      expect(files.some((file) => file.path.startsWith("DATALOG/"))).toBe(false);
      expect(rows.nights).toHaveLength(0);
      expect(rows.daily_usage).toEqual([{ day: night.night, usage: 360 }]);
    });
  });

  describe("unused-days", () => {
    const { nights, rows } = edgeCase(EdgeCaseName.UnusedDays);

    it("leaves two days between its nights unused", () => {
      expect(rows.daily_usage.map(({ usage }) => usage > 0)).toEqual([true, false, false, true]);
      expect(nights.map(({ night }) => night)).toEqual(
        rows.daily_usage.filter(({ usage }) => usage > 0).map(({ day }) => day),
      );
    });
  });

  describe("settings-change", () => {
    const { nights, rows } = edgeCase(EdgeCaseName.SettingsChange);

    it("changes one setting on its second night", () => {
      expect(rows.settings_changes).toEqual([
        {
          night: nights[1]?.night,
          setting: "max_pressure",
          old_value: nights[0]?.str["S.AS.MaxPress"],
          new_value: nights[1]?.str["S.AS.MaxPress"],
        },
      ]);
    });
  });

  describe("ahi-rounding", () => {
    const { rows } = edgeCase(EdgeCaseName.AhiRounding);

    it("has an AHI of 2.7 that airway's integer count matches", () => {
      // Floating point puts 18 / 400 * 60 just under 2.7, so ingest counts in integers.
      expect((18 / 400) * 60).toBeLessThan(2.7);
      expect(rows.events).toHaveLength(18);
      expect(rows.nights[0]?.signals["ahi"]).toBe(2.7);
      expect(rows.nights[0]?.ahi_check).toBe("match");
    });
  });

  describe("damaged-files", () => {
    const { night, zone, rows } = edgeCase(EdgeCaseName.DamagedFiles);
    const written = nightFiles(night, zone)._unsafeUnwrap();
    const verdicts = (kind: NightFile["kind"]): string[] =>
      written
        .filter((file) => file.kind === kind)
        .map((file) => {
          const size = sizeCheck(file)._unsafeUnwrap();

          return `${size.verdict} ${size.verdict === "reject" ? size.reason : size.header}`;
        });

    it("writes each damaged file at the size that its header declares", () => {
      expect(verdicts("brp")).toEqual([
        "read matches",
        "skip unknown_length",
        "reject truncated",
        "read unknown_length",
        "read undercounted",
        "read matches",
      ]);
      expect(verdicts("pld")[1]).toBe("skip unknown_length");
      expect(verdicts("sad")[1]).toBe("skip unknown_length");
      expect(verdicts("pld")[4]).toBe("read undercounted");
      expect(verdicts("sad")[4]).toBe("read undercounted");
    });

    it("keeps segments only for the BRP files that ingest reads", () => {
      expect(rows.segments.map(({ ts }) => ts)).toEqual(
        [0, 3, 4, 5].map((i) => night.segments[i]?.start),
      );
    });

    it("lists every file but the rejected one", () => {
      const brps = rows.files.filter(({ kind }) => kind === FileKind.Brp);

      expect(brps).toHaveLength(5);
      expect(rows.files.filter(({ kind }) => kind === FileKind.Pld)).toHaveLength(6);
    });
  });

  describe("split-files", () => {
    const { night, zone, rows } = edgeCase(EdgeCaseName.SplitFiles);
    const written = nightFiles(night, zone)._unsafeUnwrap();

    const pldsOf = (segment: number): string[] =>
      rows.files
        .filter((file) => file.kind === FileKind.Pld && file.segment === segment)
        .map(({ path }) => path);

    it("makes a segment without samples for a BRP that has no PLD", () => {
      expect(pldsOf(2)).toEqual([]);
      expect(rows.samples.filter(({ segment }) => segment === 2)).toHaveLength(0);
    });

    it("splits a PLD into two files while its BRP continues, and keeps every sample", () => {
      const split = written.filter((file) => file.kind === "pld" && file.segment === 2);
      const samples = rows.samples.filter(({ segment }) => segment === 3);

      expect(split).toHaveLength(2);
      expect(pldsOf(3)).toHaveLength(2);
      expect(samples).toHaveLength(1800);
      expect(samples.at(-1)?.ts).toEqual(samples[0]?.ts.add({ seconds: 2 * 1799 }));
    });

    it("writes three EVE files and two CSL files", () => {
      expect(written.filter((file) => file.kind === "eve")).toHaveLength(3);
      expect(written.filter((file) => file.kind === "csl")).toHaveLength(2);
    });

    it("writes each event to one EVE annotation and one events row", () => {
      const annotations = written
        .filter((file) => file.kind === "eve")
        .flatMap((file) => annotationsOf(file.bytes).slice(1));

      expect(annotations).toHaveLength(night.events.length);
      expect(rows.events).toHaveLength(night.events.length);
    });
  });

  describe.each([
    [EdgeCaseName.FallBack, 25],
    [EdgeCaseName.SpringForward, 23],
  ] as const)("%s", (name, hours) => {
    it(`spans the zone's ${hours.toString()}-hour day`, () => {
      const { night } = edgeCase(name);
      const day = night.night.add({ days: 1 }).toZonedDateTime("America/Chicago");
      const transition = day.getTimeZoneTransition("next")?.toInstant();

      expect(day.hoursInDay).toBe(hours);
      expect(
        transition !== undefined &&
          Temporal.Instant.compare(night.periods[0]?.on ?? transition, transition) < 0 &&
          Temporal.Instant.compare(transition, night.periods.at(-1)?.off ?? transition) < 0,
      ).toBe(true);
    });

    it("fails in a zone without daylight saving time", () => {
      expect(
        syntheticNights({ seed: 7, nights: 0, cases: [name], zone: "UTC" })._unsafeUnwrapErr(),
      ).toEqual({ kind: "no_dst_transition", name, zone: "UTC" });
    });

    it("is left out of 'all'", () => {
      expect(edgeCaseNames("all")).not.toContain(name);
    });
  });
});
