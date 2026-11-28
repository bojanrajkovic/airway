import { randomUUID } from "node:crypto";
import pg from "pg";
import { test as base } from "vitest";

// `pnpm db:up` starts Postgres at this URL. CI sets AIRWAY_TEST_POSTGRES_URL to its Postgres
// service container.
const ADMIN_URL =
  process.env["AIRWAY_TEST_POSTGRES_URL"] ?? "postgres://postgres:airway@127.0.0.1:54318/postgres";

/** Runs `sql` as the admin user, in the `postgres` database. */
async function runAsAdmin(sql: string): Promise<void> {
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

/**
 * Extends Vitest's `test` with a `databaseUrl` fixture, which is the admin user's URL for an empty
 * database. The fixture creates the database the first time a test in the file asks for it, and
 * the file's other tests share it. When the file finishes, the fixture drops the database and
 * closes any connections that are still open.
 */
export const test = base.extend<{ databaseUrl: string }>({
  databaseUrl: [
    async ({}, use) => {
      // This fixture generates the name, so it's safe to put in the statement directly.
      const name = `airway_test_${randomUUID().replaceAll("-", "")}`;
      await runAsAdmin(`create database ${name}`);

      const url = new URL(ADMIN_URL);
      url.pathname = `/${name}`;

      try {
        await use(url.toString());
      } finally {
        await runAsAdmin(`drop database ${name} with (force)`);
      }
    },
    { scope: "file" },
  ],
});

/** Runs `run` with a connected client, and closes it whether `run` returns or throws. */
export async function withClient<T>(
  url: string,
  run: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client(url);
  await client.connect();

  try {
    return await run(client);
  } finally {
    await client.end();
  }
}
