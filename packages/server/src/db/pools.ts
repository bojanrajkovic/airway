// Creates the server's Postgres connection pools. docs/server.md (Database pools) describes the
// pools and their settings.
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";

/**
 * Parses an int8 as a number. Throws on a value past 2^53, such as a corrupt counter, instead of
 * rounding it.
 */
function parseInt8(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("int8 value is outside JavaScript's safe integer range");
  }

  return value;
}

/** Maps each Postgres type OID to airway's parser for text values of that type. */
const PARSERS = new Map<number, (text: string) => unknown>([
  [20, parseInt8], // int8
  [1082, (text) => Temporal.PlainDate.from(text)], // date
  [1184, (text) => Temporal.Instant.from(text)], // timestamptz
]);

/**
 * Each pool gets these parsers in its own config. Other pg clients in the process, such as the
 * test database fixture, read pg's global `types` and keep pg's defaults.
 */
const types: pg.CustomTypesConfig = {
  // airway reads results as text, pg's default, so only text parsers are needed.
  getTypeParser: (oid: number) => {
    // pg-types types this as `any`; it is pg's own parser for the OID.
    const fallback: unknown = pg.types.getTypeParser(oid);

    return PARSERS.get(oid) ?? fallback;
  },
};

export type Pools = AsyncDisposable & {
  /** Runs every write, through Drizzle. Its statements have no timeout. */
  write: { pool: pg.Pool; db: NodePgDatabase };
  /** Runs the web API's queries. */
  api: pg.Pool;
  /** Runs agents' queries over MCP. */
  agent: pg.Pool;
};

/**
 * Creates airway's three pools. They connect lazily, on their first query, so creating them never
 * fails and a server with no database still answers /healthz.
 */
export function createPools(config: Pick<Config, "databaseUrl">, logger: Logger): Pools {
  const log = logger.child({ module: "db" });

  function pool(name: string, max: number, settings: pg.PoolConfig = {}): pg.Pool {
    const created = new pg.Pool({
      connectionString: config.databaseUrl,
      max,
      types,
      // Shows which pool a connection belongs to in pg_stat_activity.
      application_name: `airway-${name}`,
      ...settings,
    });
    // pg emits this when an idle connection drops, and crashes the process if nothing listens. The
    // pool replaces the connection on its next query.
    created.on("error", (error) => {
      log.warn({ pool: name, err: error }, "idle connection failed");
    });

    return created;
  }

  // Query pools set search_path to derived, so Postgres finds unqualified tables such as `nights`
  // there.
  const query = (timeoutMs: number): pg.PoolConfig => ({
    statement_timeout: timeoutMs,
    options: "-c search_path=derived",
  });
  const write = pool("write", 5);
  const api = pool("api", 5, query(10_000));
  const agent = pool("agent", 3, query(15_000));

  return {
    write: { pool: write, db: drizzle({ client: write }) },
    api,
    agent,
    async [Symbol.asyncDispose]() {
      await Promise.all([write.end(), api.end(), agent.end()]);
    },
  };
}
