// Defines the test Postgres's admin connection and the roles that database tests connect as. The
// default export is the `db` project's Vitest global setup. Roles are server-wide, so the setup
// creates them once per run. The setup runs outside Vitest's test context, so it can't import
// postgres.ts, which extends Vitest's `test`.
import pg from "pg";

// `pnpm db:up` publishes Postgres here. CI points the variable at its service container.
export const ADMIN_URL =
  process.env["AIRWAY_TEST_POSTGRES_URL"] ?? "postgres://postgres:airway@127.0.0.1:54318/postgres";

/** Database tests connect as these roles, which `setup` creates once per run. */
export const ROLES = { owner: "airway_owner", reader: "airway_reader" } as const;
/** Both roles use this password. The roles exist only in the test Postgres. */
export const ROLE_PASSWORD = "airway";

const { owner, reader } = ROLES;
// The value is arbitrary. Only the role setup takes this lock.
const ROLES_LOCK = 8_221_910;

/**
 * Creates the owner and reader roles if they're missing, and updates their settings, so setup can
 * run again against a Postgres that's already set up. The owner isn't a superuser and is a member
 * of the reader role.
 */
export default async function setup(): Promise<void> {
  // The names and password are ours, never input, so they're safe to put in the statements. Runs
  // that start at the same time share a Postgres. When two of them update the same role together,
  // Postgres fails one with "tuple concurrently updated". The lock makes the runs take turns.
  // Postgres runs a multi-statement query as one transaction, which holds the lock until the query
  // ends.
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
  // The connection times out before Vitest's 5-second test timeout, so a test that can't reach the
  // host fails with the message below.
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3_000 });

  try {
    await client.connect();
  } catch (error) {
    // ADMIN_URL contains a password, so the message includes only the host.
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
