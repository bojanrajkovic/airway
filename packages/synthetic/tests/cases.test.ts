import { describe, expect, it } from "vitest";
import { offsetForNight } from "@airway/contract/clock";

import { edgeCaseNames, type EdgeCaseName } from "../src/cases.ts";
import { readBackAnnotations } from "@airway/testing/edf-readback";
import { maskSlots, nightFiles, sizeCheck, type MaskSlots, type NightFile } from "../src/files.ts";
import { syntheticNights, type Synthetic, type SyntheticNight } from "../src/model.ts";
import { synthesize, type Synthesized } from "../src/synthesize.ts";

const arrivedAt = Temporal.Instant.from("2030-03-01T12:00:00Z");

// One case on its own: its nights, their offsets and files, and the rows ingest should derive.
type Built = Synthetic & Synthesized & { night: SyntheticNight };

function edgeCase(name: EdgeCaseName, zone = "America/Chicago"): Built {
  const model = syntheticNights({ seed: 7, nights: 0, cases: [name], zone })._unsafeUnwrap();
  const [night] = model.nights;

  if (night === undefined) {
    throw new Error(`${name} built no nights`);
  }

  const synthesized = synthesize(model.nights, model.offsets, {
    patient: "child",
    arrivedAt,
  })._unsafeUnwrap();

  return { ...model, ...synthesized, night };
}

const deviceTime = (at: Temporal.Instant, utcOffset: string): Temporal.PlainDateTime =>
  at.toZonedDateTimeISO(utcOffset).toPlainDateTime();

const slots = (night: SyntheticNight): MaskSlots =>
  maskSlots(
    night,
    offsetForNight([{ from: night.night, utcOffset: "-05:00" }], night.night)._unsafeUnwrap(),
  );

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
    const { night, rows } = edgeCase("many-periods");

    it("gives 10 slot sessions and 3 derived ones, matching MaskEvents", () => {
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

    it("puts a file within 60 s of two slots in the one it overlaps most", () => {
      expect(rows.segments[4]?.session).toBe(5);
    });

    it("keeps events 45 s before a period inside it, and marks events 120 s after one outside", () => {
      const outside = rows.events.filter((event) => event.outside_mask_on);

      expect(outside).toHaveLength(11);
      for (const event of outside) {
        expect(event.type).toBe("hypopnea");
      }
    });
  });

  describe("noon-edge", () => {
    const { night, rows } = edgeCase("noon-edge");

    it("leaves slot 0 without a mask-on", () => {
      expect(slots(night).maskOn[0]).toBeNaN();
      expect(slots(night).maskOff[0]).toBe(40);
    });

    it("starts the first session at noon on the device clock", () => {
      expect(rows.sessions[0]?.ts).toEqual(
        Temporal.Instant.from(`${night.night.toString()}T12:00:00-05:00`),
      );
      expect(rows.segments[0]?.session).toBe(1);
    });
  });

  describe("sub-minute-period", () => {
    const { night, rows } = edgeCase("sub-minute-period");

    it("records the pair's mask-on and mask-off in the same minute, with no BRP file", () => {
      const { maskOn, maskOff } = slots(night);

      expect(maskOn[1]).toBe(maskOff[1]);
      expect(night.segments).toHaveLength(2);
    });

    it("makes no session for the pair, so the count can't match MaskEvents", () => {
      expect(rows.sessions).toHaveLength(2);
      expect(rows.nights[0]?.expected_sessions).toBe(3);
      expect(rows.nights[0]?.session_count_approximate).toBe(true);
    });
  });

  describe("folderless-day", () => {
    const { night, files, rows } = edgeCase("folderless-day");

    it("records the day's usage in STR.edf, with no DATALOG folder", () => {
      expect(files.some((file) => file.path.startsWith("DATALOG/"))).toBe(false);
      expect(rows.nights).toHaveLength(0);
      expect(rows.daily_usage).toEqual([{ day: night.night, usage: 360 }]);
    });
  });

  describe("unused-days", () => {
    const { nights, rows } = edgeCase("unused-days");

    it("leaves two days between its nights unused", () => {
      expect(rows.daily_usage.map(({ usage }) => usage > 0)).toEqual([true, false, false, true]);
      expect(nights.map(({ night }) => night)).toEqual(
        rows.daily_usage.filter(({ usage }) => usage > 0).map(({ day }) => day),
      );
    });
  });

  describe("settings-change", () => {
    const { nights, rows } = edgeCase("settings-change");

    it("changes one setting on its second night", () => {
      expect(rows.settings_changes).toEqual([
        {
          night: nights[1]?.night,
          setting: "max_pressure",
          old_value: nights[0]?.str.get("S.AS.MaxPress"),
          new_value: nights[1]?.str.get("S.AS.MaxPress"),
        },
      ]);
    });
  });

  describe("ahi-rounding", () => {
    const { rows } = edgeCase("ahi-rounding");

    it("gives an AHI of 2.7 that airway's integer count matches", () => {
      // The trap ingest avoids: floating point puts this just under 2.7.
      expect((18 / 400) * 60).toBeLessThan(2.7);
      expect(rows.events).toHaveLength(18);
      expect(rows.nights[0]?.signals["ahi"]).toBe(2.7);
      expect(rows.nights[0]?.ahi_check).toBe("match");
    });
  });

  describe("clock-change", () => {
    const { nights, offsets, files } = edgeCase("clock-change");
    const [first, second] = nights;

    it("adds a second offset from its second night", () => {
      expect(offsets).toContainEqual({ from: second?.night, utcOffset: "-04:55" });
    });

    it("names each night's files on its own offset, across midnight", () => {
      const name = (at: Temporal.Instant | undefined, utcOffset: string): string =>
        at === undefined
          ? ""
          : deviceTime(at, utcOffset)
              .toString()
              .replaceAll("-", "")
              .replace("T", "_")
              .replaceAll(":", "")
              .slice(0, 15);
      const brps = files.filter((file) => file.path.endsWith("_BRP.edf")).map((file) => file.path);
      const lastSegment = second?.segments.at(-1);

      expect(brps.some((path) => path.includes(name(first?.segments[0]?.start, "-05:00")))).toBe(
        true,
      );
      expect(brps.some((path) => path.includes(name(lastSegment?.start, "-04:55")))).toBe(true);
      expect(
        lastSegment === undefined ? undefined : deviceTime(lastSegment.end, "-04:55").toPlainDate(),
      ).toEqual(second?.night.add({ days: 1 }));
    });
  });

  describe("damaged-files", () => {
    const { night, offsets, rows } = edgeCase("damaged-files");
    const written = nightFiles(night, offsets)._unsafeUnwrap();
    const verdicts = (kind: NightFile["kind"]): string[] =>
      written
        .filter((file) => file.kind === kind)
        .map((file) => {
          const size = sizeCheck(file);

          return `${size.verdict} ${size.verdict === "reject" ? size.reason : size.header}`;
        });

    it("writes each damaged file at the size its header promises", () => {
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

    it("keeps a segment only for each BRP file ingest reads", () => {
      expect(rows.segments.map(({ ts }) => ts)).toEqual(
        [0, 3, 4, 5].map((i) => night.segments[i]?.start),
      );
    });

    it("lists every file but the rejected one", () => {
      const brps = rows.files.filter(({ kind }) => kind === "brp");

      expect(brps).toHaveLength(5);
      expect(rows.files.filter(({ kind }) => kind === "pld")).toHaveLength(6);
    });
  });

  describe("split-files", () => {
    const { night, offsets, rows } = edgeCase("split-files");
    const written = nightFiles(night, offsets)._unsafeUnwrap();

    const pldsOf = (segment: number): string[] =>
      rows.files
        .filter((file) => file.kind === "pld" && file.segment === segment)
        .map(({ path }) => path);

    it("gives a BRP with no PLD a segment without samples", () => {
      expect(pldsOf(2)).toEqual([]);
      expect(rows.samples.filter(({ segment }) => segment === 2)).toHaveLength(0);
    });

    it("splits a PLD into two files while its BRP keeps going, with every sample", () => {
      const split = written.filter((file) => file.kind === "pld" && file.segment === 2);
      const samples = rows.samples.filter(({ segment }) => segment === 3);

      expect(split).toHaveLength(2);
      expect(pldsOf(3)).toHaveLength(2);
      expect(samples).toHaveLength(1800);
      expect(samples.at(-1)?.ts).toEqual(samples[0]?.ts.add({ seconds: 2 * 1799 }));
    });

    it("writes three EVE files and two CSL files, with each event in one of them", () => {
      const eves = written.filter((file) => file.kind === "eve");
      const annotations = eves.flatMap((file) => readBackAnnotations(file.bytes).slice(1));

      expect(eves).toHaveLength(3);
      expect(written.filter((file) => file.kind === "csl")).toHaveLength(2);
      expect(annotations).toHaveLength(night.events.length);
      expect(rows.events).toHaveLength(night.events.length);
    });
  });

  describe.each([
    ["fall-back", 25],
    ["spring-forward", 23],
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
