import { pino } from "pino";
import type { Config } from "../../src/config.ts";
import type { AppContext } from "../../src/runtime/context.ts";

// Synthetic values only: this is a public repo.
const CONFIG: Config = {
  databaseUrl: "postgres://airway:secret@db.test:5432/airway",
  readerDatabaseUrl: "postgres://airway_reader:secret@db.test:5432/airway",
  patient: {
    name: "Test Patient",
    birthDate: Temporal.PlainDate.from("2012-06-15"),
    adultRulesFrom13: false,
  },
  clockOffsets: [{ from: Temporal.PlainDate.from("2025-01-01"), utcOffset: "-05:07" }],
  timeZone: "America/Chicago",
  uiHost: "airway.example.test",
  mcpHost: "airway-mcp.example.test",
  jwksUrl: "https://airway-mcp.example.test/.well-known/pomerium/jwks.json",
  mirrorPath: "/mirror",
  port: 3000,
  logLevel: "info",
};

/** An AppContext for tests: synthetic config, a silent logger, and a fixed clock. */
export function testContext(overrides: Partial<AppContext> = {}): AppContext {
  return {
    config: CONFIG,
    logger: pino({ level: "silent" }),
    clock: () => Temporal.Instant.from("2026-01-15T12:00:00Z"),
    ...overrides,
  };
}
