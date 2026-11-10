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
  AIRWAY_CPAP_DATA_PATH: "/cpap-data",
  AIRWAY_AUTH: "none",
  AIRWAY_LOCAL_AUTHOR_NAME: "Sam Rivera",
  AIRWAY_LOCAL_AUTHOR_EMAIL: "sam@example.test",
};

const { AIRWAY_LOCAL_AUTHOR_NAME, AIRWAY_LOCAL_AUTHOR_EMAIL, ...SHARED } = VALID;
const POMERIUM = {
  ...SHARED,
  AIRWAY_AUTH: "pomerium",
  AIRWAY_UI_HOST: "airway.example.test",
  AIRWAY_MCP_HOST: "airway-mcp.example.test",
  AIRWAY_JWKS_URL: "http://pomerium.example.test/.well-known/pomerium/jwks.json",
};

const problems = (env: Record<string, string | undefined>): string[] => {
  const result = parseConfig(env);

  return result.isErr() ? result.error : [];
};

describe("parseConfig", () => {
  it("parses a complete environment, with defaults for the optional keys", () => {
    const result = parseConfig(VALID);

    expect(result.isOk()).toBe(true);

    if (result.isOk()) {
      expect(result.value.port).toBe(3000);
      expect(result.value.logLevel).toBe("info");
      expect(result.value.patient.adultRulesFrom13).toBe(false);
      expect(result.value.patient.birthDate.equals("2012-06-15")).toBe(true);
      expect(result.value.clockOffsets[0]?.utcOffset).toBe("-05:07");
      expect(result.value.auth).toEqual({
        mode: "none",
        author: { name: AIRWAY_LOCAL_AUTHOR_NAME, email: AIRWAY_LOCAL_AUTHOR_EMAIL },
      });
    }
  });

  it("parses pomerium mode without the local author's settings", () => {
    expect(parseConfig(POMERIUM)._unsafeUnwrap().auth).toEqual({
      mode: "pomerium",
      uiHost: "airway.example.test",
      mcpHost: "airway-mcp.example.test",
      jwksUrl: "http://pomerium.example.test/.well-known/pomerium/jwks.json",
    });
  });

  it.each(["AIRWAY_UI_HOST", "AIRWAY_MCP_HOST", "AIRWAY_JWKS_URL"])(
    "names %s when it's missing in pomerium mode",
    (key) => {
      expect(problems({ ...POMERIUM, [key]: undefined })).toEqual([`${key}: is required`]);
    },
  );

  it.each([
    ["AIRWAY_AUTH", "off"],
    ["AIRWAY_UI_HOST", "https://airway.example.test"],
    ["AIRWAY_MCP_HOST", "airway-mcp.example.test:443"],
    ["AIRWAY_JWKS_URL", "file:///jwks.json"],
  ])("names %s when it's malformed in pomerium mode", (key, value) => {
    expect(problems({ ...POMERIUM, [key]: value })).toEqual([
      expect.stringMatching(new RegExp(`^${key}: `, "v")),
    ]);
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
    ["AIRWAY_TIME_ZONE", "-06:00"],
    ["AIRWAY_TIME_ZONE", "Etc/UTC"],
    ["AIRWAY_CPAP_DATA_PATH", "relative/cpap-data"],
    ["PORT", "70000"],
    ["LOG_LEVEL", "verbose"],
    ["AIRWAY_LOCAL_AUTHOR_NAME", " "],
    ["AIRWAY_LOCAL_AUTHOR_EMAIL", "sam"],
  ])("names %s when it's malformed", (key, value) => {
    expect(problems({ ...VALID, [key]: value })).toEqual([
      expect.stringMatching(new RegExp(`^${key}: `, "v")),
    ]);
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
