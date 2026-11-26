import { instantAt as at } from "@airway/testing/time";
import { describe, expect, test } from "vitest";
import { dataMissing, lastNightKey } from "../../src/api/last-night.ts";
import type { DailyUsageRow } from "../../src/derived/rows.ts";

// Each zone changes to daylight saving time on a different date, and its tests run on that day.
const ZONES = [
  ["America/New_York", "2030-03-10"],
  ["Europe/Berlin", "2030-03-31"],
] as const;

const used: Pick<DailyUsageRow, "usage"> = { usage: 420 };
const unused: Pick<DailyUsageRow, "usage"> = { usage: 0 };
const cutoff = Temporal.PlainTime.from("15:00");

describe.each(ZONES)("in %s, on its DST-change day %s", (zone, day) => {
  test.for([
    ["a used night with its folder", used, true, "arrived", "arrived"],
    ["an unused night", unused, false, "unused", "unused"],
    ["a used night without its folder", used, false, "pending", "missing"],
    ["a night with no STR.edf record", undefined, false, "pending", "missing"],
  ] as const)("%s is %s at 14:59 and %s at 15:00", ([, strDay, folder, before, after]) => {
    expect(dataMissing(strDay, folder, at(zone, day, "14:59"), { zone, cutoff })).toBe(before);
    expect(dataMissing(strDay, folder, at(zone, day, "15:00"), { zone, cutoff })).toBe(after);
  });
});

test("uses the configured cutoff", () => {
  const zone = "America/New_York";
  const home = { zone, cutoff: Temporal.PlainTime.from("09:30") };

  expect(dataMissing(used, false, at(zone, "2030-06-11", "09:29"), home)).toBe("pending");
  expect(dataMissing(used, false, at(zone, "2030-06-11", "09:30"), home)).toBe("missing");
});

describe("lastNightKey", () => {
  const zone = "America/New_York";

  test("is yesterday's date until midnight in the home zone", () => {
    expect(lastNightKey(at(zone, "2030-06-11", "23:59:59"), zone).toString()).toBe("2030-06-10");
    expect(lastNightKey(at(zone, "2030-06-12", "00:00"), zone).toString()).toBe("2030-06-11");
  });

  test("follows the home zone's date across a DST change", () => {
    // 23:30 EST on 3 November is 04:30 UTC on the 4th.
    expect(lastNightKey(at(zone, "2030-11-03", "23:30"), zone).toString()).toBe("2030-11-02");
    expect(lastNightKey(at(zone, "2030-03-10", "03:30"), zone).toString()).toBe("2030-03-09");
  });
});
