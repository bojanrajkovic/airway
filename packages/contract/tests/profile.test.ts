import { describe, expect, it } from "vitest";
import { ruleSetFor, type PatientProfile } from "../src/profile.ts";

const night = (iso: string): Temporal.PlainDate => Temporal.PlainDate.from(iso);
const profile = (overrides: Partial<PatientProfile> = {}): PatientProfile => ({
  name: "Test Patient",
  birthDate: night("2012-06-15"),
  adultRulesFrom13: false,
  ...overrides,
});

describe("ruleSetFor", () => {
  it.each([
    ["the night before the 18th birthday", "2030-06-14", "pediatric"],
    ["the night of the 18th birthday", "2030-06-15", "adult"],
    ["a night after it", "2031-01-01", "adult"],
  ] as const)("uses %s → %s", (_, iso, expected) => {
    expect(ruleSetFor(night(iso), profile())).toBe(expected);
  });

  it.each([
    ["the night before the 13th birthday", "2025-06-14", "pediatric"],
    ["the night of the 13th birthday", "2025-06-15", "adult"],
  ] as const)("with the override, uses %s → %s", (_, iso, expected) => {
    expect(ruleSetFor(night(iso), profile({ adultRulesFrom13: true }))).toBe(expected);
  });

  it("counts a 29 February birthday from 28 February in other years", () => {
    const leap = profile({ birthDate: night("2008-02-29") });

    expect(ruleSetFor(night("2026-02-27"), leap)).toBe("pediatric");
    expect(ruleSetFor(night("2026-02-28"), leap)).toBe("adult");
  });
});
