import type { Config } from "../config.ts";
import type { Pools } from "../db/pools.ts";
import type { Logger } from "../logger.ts";

/**
 * The shared context for the entire app. main.ts builds it once and passes it whole; services take
 * it plus their own arguments, and modules log through `logger.child({ module })`.
 */
export type AppContext = {
  config: Config;
  logger: Logger;
  /** The current time, so tests can fix it. */
  clock: () => Temporal.Instant;
  /** The owner, API, and agent database pools. */
  db: Pools;
};
