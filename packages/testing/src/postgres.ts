import { randomUUID } from "node:crypto";
import pg from "pg";
import { test as base } from "vitest";

// `pnpm db:up` publishes Postgres here. CI points the variable at its service container.
const ADMIN_URL =
  process.env["AIRWAY_TEST_POSTGRES_URL"] ?? "postgres://postgres:airway@127.0.0.1:54318/postgres";

type PostgresFixtures = { databaseUrl: string };

/**
 * Vitest's `test`, plus a `databaseUrl` fixture: a connection URL for an empty database that's
 * created the first time a test in the file asks for it, shared by the file's other tests, and
 * dropped (closing any connections still open) when the file finishes.
 */
export const test = base.extend<PostgresFixtures>({
  databaseUrl: [
    async ({}, use) => {
      // The name is ours, never input, so it's safe to put in the statement directly.
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

async function runAsAdmin(sql: string): Promise<void> {
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
