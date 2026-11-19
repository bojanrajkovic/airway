import { describe, expect, it } from "vitest";
import { settingsChanges } from "../../src/derived/settings.ts";
import type { StrDay } from "../../src/derived/str.ts";

const date = (day: number): Temporal.PlainDate =>
  Temporal.PlainDate.from("2030-01-01").add({ days: day });
const BASE = { min_pressure: 6, max_pressure: 12, epr_level: 2, ramp_time: 20 };

const used = (day: number, settings: Partial<typeof BASE> = {}): StrDay => ({
  day: date(day),
  used: true,
  maskOn: [],
  maskOff: [],
  maskEvents: 2,
  signals: {},
  settings: { ...BASE, ...settings },
});
const unused = (day: number): StrDay => ({ day: date(day), used: false });

describe("settingsChanges", () => {
  it("gives one row per changed setting", () => {
    const days = [
      used(0),
      used(1, { max_pressure: 14 }),
      used(2, { max_pressure: 14, ramp_time: 5 }),
    ];

    expect(settingsChanges(days, date(0))).toEqual([
      { night: date(1), setting: "max_pressure", old_value: 12, new_value: 14 },
      { night: date(2), setting: "ramp_time", old_value: 20, new_value: 5 },
    ]);
  });

  it("skips unused days and compares with the last used day", () => {
    const days = [used(0), unused(1), unused(2), used(3, { min_pressure: 7 })];

    expect(settingsChanges(days, date(0))).toEqual([
      { night: date(3), setting: "min_pressure", old_value: 6, new_value: 7 },
    ]);
  });

  it("compares the first day from `from` with an earlier used day", () => {
    const days = [used(0), used(1, { epr_level: 3 }), used(2, { epr_level: 3 })];

    expect(settingsChanges(days, date(1))).toEqual([
      { night: date(1), setting: "epr_level", old_value: 2, new_value: 3 },
    ]);
  });

  it("gives no rows before `from`", () => {
    const days = [used(0), used(1, { epr_level: 3 }), used(2, { epr_level: 3 })];

    expect(settingsChanges(days, date(2))).toEqual([]);
  });

  it("gives the first used day no rows", () => {
    expect(settingsChanges([unused(0), used(1, { max_pressure: 20 })], date(0))).toEqual([]);
  });

  it("reports a setting that became null as a change", () => {
    const days = [used(0), { ...used(1), settings: { ...BASE, ramp_time: null } }];

    expect(settingsChanges(days, date(0))).toEqual([
      { night: date(1), setting: "ramp_time", old_value: 20, new_value: null },
    ]);
  });
});
