import { describe, expect, it } from "vitest";
import { ClockOffsets, offsetForNight } from "../src/clock.ts";

const offsets = ClockOffsets.parse([
  { from: "2030-01-01", utcOffset: "-05:00" },
  { from: "2030-03-01", utcOffset: "-04:00" },
]);

describe("offsetForNight", () => {
  it.each([
    ["2030-01-01", "-05:00"],
    ["2030-02-28", "-05:00"],
    ["2030-03-01", "-04:00"],
    ["2031-01-01", "-04:00"],
  ])("gives %s the offset %s", (night, utcOffset) => {
    const offset = offsetForNight(offsets, Temporal.PlainDate.from(night))._unsafeUnwrap();

    expect(offset.utcOffset).toBe(utcOffset);
  });

  it("has no offset for a night before the first entry", () => {
    const night = Temporal.PlainDate.from("2029-12-31");

    expect(offsetForNight(offsets, night)._unsafeUnwrapErr()).toEqual({
      kind: "before_first_offset",
      night,
    });
  });
});
