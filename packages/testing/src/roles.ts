// The test Postgres's admin connection and the roles database tests connect as. The default export
// is the `db` project's Vitest global setup. Roles are server-wide, so it creates them once per run. It runs outside Vitest's test context, so it can't import
// postgres.ts, which extends Vitest's `test`.
import pg from "pg";

// `pnpm db:up` publishes Postgres here. CI points the variable at its service container.
export const ADMIN_URL =
  process.env["AIRWAY_TEST_POSTGRES_URL"] ?? "postgres://postgres:airway@127.0.0.1:54318/postgres";

/** The roles database tests connect as, which `setup` creates once per run. */
export const ROLES = { owner: "airway_owner", reader: "airway_reader" } as const;
/** Both roles' password. They exist only in the test Postgres. */
export const ROLE_PASSWORD = "airway";

const { owner, reader } = ROLES;
// Any constant; only the role setup takes this lock.
const ROLES_LOCK = 8_221_910;

/**
 * Creates the owner and reader roles if they're missing, and brings their settings up to date, so
 * it can run again against a Postgres that's already set up. The reader gets the settings the
 * deployment gives it. The owner isn't a superuser, and as in production it's a member of the
 * reader role, which lets it cancel a reader's query.
 */
export default async function setup(): Promise<void> {
  // The names and password are ours, never input, so they're safe to put in the statements. Runs
  // started at once share a Postgres and would update the same roles together, which Postgres
  // fails with "tuple concurrently updated". The lock makes them take turns. Postgres runs a
  // multi-statement query as one transaction, which holds the lock until the query ends.
  await runAsAdmin(`
select pg_advisory_xact_lock(${ROLES_LOCK.toString()});
do $$
begin
  if not exists (select from pg_roles where rolname = '${owner}') then
    create role ${owner} login nosuperuser password '${ROLE_PASSWORD}';
  end if;
  if not exists (select from pg_roles where rolname = '${reader}') then
    create role ${reader} login nosuperuser password '${ROLE_PASSWORD}';
  end if;
end
$$;
alter role ${reader} set default_transaction_read_only = on;
alter role ${reader} set search_path = derived;
alter role ${reader} set work_mem = '64MB';
alter role ${reader} set temp_file_limit = '1GB';
grant ${reader} to ${owner};
`);
}

/** Runs `sql` as the admin user, in the `postgres` database. */
export async function runAsAdmin(sql: string): Promise<void> {
  // Under Vitest's 5-second test timeout, so a host that never answers gets the message below.
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3_000 });

  try {
    await client.connect();
  } catch (error) {
    // The URL holds a password, so the message names only the host. The cause says what failed.
    throw new Error(
      `Couldn't connect to Postgres at ${new URL(ADMIN_URL).host}. If it isn't running, start it with \`pnpm db:up\`, or set AIRWAY_TEST_POSTGRES_URL.`,
      { cause: error },
    );
  }

  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
