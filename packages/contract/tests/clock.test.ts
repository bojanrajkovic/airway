import { describe, expect, it } from "vitest";
import { toDeviceTime, toInstant, winterOffset } from "../src/clock.ts";

describe("winterOffset", () => {
  it.each([
    ["America/New_York", "-05:00"],
    ["Australia/Sydney", "+10:00"],
    ["Europe/Dublin", "+00:00"],
    ["Asia/Tokyo", "+09:00"],
  ])("gives %s the offset %s", (zone, offset) => {
    expect(winterOffset(zone, 2030)).toBe(offset);
  });
});

describe("toInstant", () => {
  const zone = "America/New_York";

  it("reads a device-clock time with the zone's winter offset", () => {
    expect(toInstant(Temporal.PlainDateTime.from("2030-01-05T23:30"), zone)).toEqual(
      Temporal.Instant.from("2030-01-06T04:30Z"),
    );
  });

  it("uses the winter offset in summer, as the device clock does", () => {
    expect(toInstant(Temporal.PlainDateTime.from("2030-07-05T23:30"), zone)).toEqual(
      Temporal.Instant.from("2030-07-06T04:30Z"),
    );
  });

  it("reverses toDeviceTime", () => {
    const time = Temporal.PlainDateTime.from("2030-03-10T02:30");

    expect(toDeviceTime(toInstant(time, zone), zone)).toEqual(time);
  });
});
