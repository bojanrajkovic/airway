import { pino } from "pino";
import type { Config } from "../../src/config.ts";
import { createPools } from "../../src/db/pools.ts";
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
  cpapDataPath: "/cpap-data",
  port: 3000,
  logLevel: "info",
};

/**
 * An AppContext for tests: synthetic config, a silent logger, a fixed clock, and pools on the
 * synthetic URLs, which never connect unless a test queries them.
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
