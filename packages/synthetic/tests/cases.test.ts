import { describe, expect, it } from "vitest";
import { offsetForNight } from "@airway/contract/clock";
import type { DerivedRows } from "@airway/contract/derived/rows";
import { type EdgeCaseName } from "../src/cases.ts";
import { maskSlots, type MaskSlots } from "../src/files.ts";
import { syntheticNights, type SyntheticNight } from "../src/model.ts";
import { synthesize } from "../src/synthesize.ts";

const uploadedAt = Temporal.Instant.from("2030-03-01T12:00:00Z");

// One case on its own: its night, and the rows ingest should derive from its files.
type Built = { night: SyntheticNight; rows: DerivedRows };

function edgeCase(name: EdgeCaseName): Built {
  const { nights, offsets } = syntheticNights({ seed: 7, nights: 0, cases: [name] });
  const [night] = nights;

  if (night === undefined) {
    throw new Error(`${name} built no nights`);
  }

  const { rows } = synthesize(nights, offsets, { patient: "child", uploadedAt })._unsafeUnwrap();

  return { night, rows };
}

const slots = (night: SyntheticNight): MaskSlots =>
  maskSlots(
    night,
    offsetForNight([{ from: night.night, utcOffset: "-05:00" }], night.night)._unsafeUnwrap(),
  );

describe("edge cases", () => {
  it("leave the base nights unchanged", () => {
    const base = syntheticNights({ seed: 7, nights: 3 });
    const withCases = syntheticNights({ seed: 7, nights: 3, cases: "all" });

    expect(withCases.nights.slice(0, 3)).toEqual(base.nights);
    expect(withCases.nights.length).toBeGreaterThan(3);
  });

  it("follow the base nights on consecutive dates", () => {
    const { nights } = syntheticNights({ seed: 7, nights: 2, cases: "all" });

    nights.forEach((night, i) => {
      expect(night.night).toEqual(nights[0]?.night.add({ days: i }));
    });
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
});
