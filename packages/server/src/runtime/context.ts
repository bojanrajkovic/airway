import type { Config } from "../config.ts";
import type { Pools } from "../db/pools.ts";
import type { NightPool } from "../ingest/pool.ts";
import type { Logger } from "../logger.ts";

/**
 * `AppContext` is the context object that the whole app shares. main.ts builds it once and passes
 * the whole object to each service, along with the service's own arguments. Each module logs
 * through `logger.child({ module })`.
 */
export type AppContext = {
  config: Config;
  logger: Logger;
  /** Returns the current time. Tests pass a clock that returns a fixed instant. */
  clock: () => Temporal.Instant;
  /** Contains one database pool for writes, one for the web API, and one for agents. */
  db: Pools;
  /** Computes nights in worker threads. */
  nightPool: NightPool;
};
