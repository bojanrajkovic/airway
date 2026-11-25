import type { Config } from "../config.ts";
import type { Pools } from "../db/pools.ts";
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
  /** `db` has one database pool each for the owner, the API, and the agent. */
  db: Pools;
};
