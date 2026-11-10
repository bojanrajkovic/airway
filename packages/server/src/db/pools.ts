// The server's Postgres connections. docs/server.md (Database pools) describes the roles and limits.
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";

/** An int8 as a number. Throws instead of rounding one past 2^53, such as a corrupt counter. */
function parseInt8(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("int8 value is outside JavaScript's safe integer range");
  }

  return value;
}

/** airway's parsers for Postgres text values, by type OID. */
const PARSERS = new Map<number, (text: string) => unknown>([
  [20, parseInt8], // int8
  [1082, (text) => Temporal.PlainDate.from(text)], // date
  [1184, (text) => Temporal.Instant.from(text)], // timestamptz
]);

/**
 * Set on each pool rather than on pg's global `types`, so other pg clients in the process (such as
 * the test database fixture) keep pg's defaults.
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
  /** The owner role: every write, through Drizzle. No statement timeout. */
  owner: { pool: pg.Pool; db: NodePgDatabase };
  /** The read-only reader role, for the web API's queries. */
  api: pg.Pool;
  /** The read-only reader role, for agents' queries over MCP. */
  agent: pg.Pool;
};

/**
 * Creates airway's three pools. They connect lazily, on their first query, so creating them never
 * fails and a server with no database still answers /healthz.
 */
export function createPools(
  config: Pick<Config, "databaseUrl" | "readerDatabaseUrl">,
  logger: Logger,
): Pools {
  const log = logger.child({ module: "db" });

  function pool(name: string, connectionString: string, max: number, timeoutMs?: number): pg.Pool {
    const created = new pg.Pool({
      connectionString,
      max,
      types,
      // Shows which pool a connection belongs to in pg_stat_activity.
      application_name: `airway-${name}`,
      ...(timeoutMs === undefined ? {} : { statement_timeout: timeoutMs }),
    });
    // pg emits this when an idle connection drops, and crashes the process if nothing listens. The
    // pool replaces the connection on its next query. The message isn't logged: a database error's
    // message can hold data.
    created.on("error", (error) => {
      log.warn(
        { pool: name, code: "code" in error ? String(error.code) : error.name },
        "idle connection failed",
      );
    });

    return created;
  }

  const owner = pool("owner", config.databaseUrl, 5);
  const api = pool("api", config.readerDatabaseUrl, 5, 10_000);
  const agent = pool("agent", config.readerDatabaseUrl, 3, 15_000);

  return {
    owner: { pool: owner, db: drizzle({ client: owner }) },
    api,
    agent,
    async [Symbol.asyncDispose]() {
      await Promise.all([owner.end(), api.end(), agent.end()]);
    },
  };
}
