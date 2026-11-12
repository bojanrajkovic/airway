import { instantAt as at } from "@airway/testing/time";
import { describe, expect, test } from "vitest";
import { dataMissing, lastNightKey, type StrDay } from "../../src/api/last-night.ts";

// Two zones with daylight saving time on different dates, and a DST-change day in each.
const ZONES = [
  ["America/New_York", "2030-03-10"],
  ["Europe/Berlin", "2030-03-31"],
] as const;

const used: StrDay = { usage: 420 };
const unused: StrDay = { usage: 0 };

describe.each(ZONES)("in %s, on its DST-change day %s", (zone, day) => {
  test.for([
    ["a used night with its folder", used, true, "arrived", "arrived"],
    ["an unused night", unused, false, "unused", "unused"],
    ["a used night without its folder", used, false, "pending", "missing"],
    ["a night with no STR.edf record", undefined, false, "pending", "missing"],
  ] as const)("%s is %s at 14:59 and %s at 15:00", ([, strDay, folder, before, after]) => {
    expect(dataMissing(strDay, folder, at(zone, day, "14:59"), zone)).toBe(before);
    expect(dataMissing(strDay, folder, at(zone, day, "15:00"), zone)).toBe(after);
  });
});

describe("lastNightKey", () => {
  const zone = "America/New_York";

  test("is yesterday's date until midnight, home time", () => {
    expect(lastNightKey(at(zone, "2030-06-11", "23:59:59"), zone).toString()).toBe("2030-06-10");
    expect(lastNightKey(at(zone, "2030-06-12", "00:00"), zone).toString()).toBe("2030-06-11");
  });

  test("follows the home date across a DST change, not UTC's", () => {
    // 23:30 EST on 3 November is 04:30 UTC on the 4th.
    expect(lastNightKey(at(zone, "2030-11-03", "23:30"), zone).toString()).toBe("2030-11-02");
    expect(lastNightKey(at(zone, "2030-03-10", "03:30"), zone).toString()).toBe("2030-03-09");
  });
});
