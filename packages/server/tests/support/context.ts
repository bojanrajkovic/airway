import { pino } from "pino";
import type { Config } from "../../src/config.ts";
import { createPools } from "../../src/db/pools.ts";
import type { AppContext } from "../../src/runtime/context.ts";

const CONFIG: Config = {
  databaseUrl: "postgres://airway:secret@db.test:5432/airway",
  readerDatabaseUrl: "postgres://airway_reader:secret@db.test:5432/airway",
  patient: {
    name: "Test Patient",
    birthDate: Temporal.PlainDate.from("2012-06-15"),
    adultRulesFrom13: false,
  },
  timeZone: "America/Chicago",
  cpapDataPath: "/cpap-data",
  dataMissingCutoff: Temporal.PlainTime.from("15:00"),
  port: 3000,
  logLevel: "info",
  auth: { mode: "none", author: { name: "Sam Rivera", email: "sam@example.test" } },
};

/**
 * Returns an AppContext for tests with synthetic config, a silent logger, a fixed clock, and
 * database pools. A pool connects to its synthetic URL only when a test runs a query.
 */
export function testContext(overrides: Partial<AppContext> = {}): AppContext {
  const logger = pino({ level: "silent" });

  return {
    config: CONFIG,
    logger,
    clock: () => Temporal.Instant.from("2026-01-15T12:00:00Z"),
    db: createPools(CONFIG, logger),
    ...overrides,
  };
}
