import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";

// Synthetic values only: this is a public repo.
const VALID = {
  DATABASE_URL: "postgres://airway:secret@db.test:5432/airway",
  AIRWAY_READER_DATABASE_URL: "postgres://airway_reader:secret@db.test:5432/airway",
  AIRWAY_PATIENT_NAME: "Test Patient",
  AIRWAY_PATIENT_BIRTH_DATE: "2012-06-15",
  AIRWAY_CLOCK_OFFSETS: '[{"from":"2025-01-01","utcOffset":"-05:07"}]',
  AIRWAY_TIME_ZONE: "America/Chicago",
  AIRWAY_UI_HOST: "airway.example.test",
  AIRWAY_MCP_HOST: "airway-mcp.example.test",
  AIRWAY_JWKS_URL: "https://airway-mcp.example.test/.well-known/pomerium/jwks.json",
  AIRWAY_MIRROR_PATH: "/mirror",
};

const problems = (env: Record<string, string | undefined>): string[] => {
  const result = parseConfig(env);

  return result.kind === "invalid" ? result.problems : [];
};

describe("parseConfig", () => {
  it("parses a complete environment, with defaults for the optional keys", () => {
    const result = parseConfig(VALID);

    expect(result.kind).toBe("ok");

    if (result.kind === "ok") {
      expect(result.config.port).toBe(3000);
      expect(result.config.logLevel).toBe("info");
      expect(result.config.patient.adultRulesFrom13).toBe(false);
      expect(result.config.patient.birthDate.equals("2012-06-15")).toBe(true);
      expect(result.config.clockOffsets[0]?.utcOffset).toBe("-05:07");
    }
  });

  it.each(Object.keys(VALID))("names %s when it's missing", (key) => {
    expect(problems({ ...VALID, [key]: undefined })).toEqual([
      expect.stringMatching(new RegExp(`^${key}: `, "v")),
    ]);
  });

  it.each([
    ["DATABASE_URL", "mysql://db.test/airway"],
    ["AIRWAY_PATIENT_NAME", "   "],
    ["AIRWAY_PATIENT_BIRTH_DATE", "2012-13-45"],
    ["AIRWAY_ADULT_RULES_FROM_13", "yes"],
    ["AIRWAY_CLOCK_OFFSETS", "not json"],
    ["AIRWAY_CLOCK_OFFSETS", '[{"from":"2025-01-01","utcOffset":"-5"}]'],
    ["AIRWAY_TIME_ZONE", "America/Atlantis"],
    ["AIRWAY_UI_HOST", "https://airway.example.test"],
    ["AIRWAY_JWKS_URL", "not a url"],
    ["AIRWAY_MIRROR_PATH", "relative/mirror"],
    ["PORT", "70000"],
    ["LOG_LEVEL", "verbose"],
  ])("names %s when it's malformed", (key, value) => {
    expect(problems({ ...VALID, [key]: value })).toEqual([
      expect.stringMatching(new RegExp(`^${key}: `, "v")),
    ]);
  });

  it("never echoes a value back, so a bad birth date doesn't end up in the logs", () => {
    const found = problems({
      ...VALID,
      AIRWAY_PATIENT_BIRTH_DATE: "2012-13-45",
      DATABASE_URL: "mysql://u:hunter2@x/db",
    });

    expect(found).toHaveLength(2);
    expect(found.join("\n")).not.toMatch(/2012-13-45|hunter2/v);
  });

  it.each([
    [
      "unsorted",
      '[{"from":"2025-06-01","utcOffset":"-05:07"},{"from":"2025-01-01","utcOffset":"-05:00"}]',
    ],
    [
      "duplicate",
      '[{"from":"2025-01-01","utcOffset":"-05:07"},{"from":"2025-01-01","utcOffset":"-05:00"}]',
    ],
  ])("rejects %s clock offsets", (_, offsets) => {
    expect(problems({ ...VALID, AIRWAY_CLOCK_OFFSETS: offsets })).toEqual([
      expect.stringMatching(/^AIRWAY_CLOCK_OFFSETS: /v),
    ]);
  });
});
