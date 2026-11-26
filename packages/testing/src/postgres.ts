import { randomUUID } from "node:crypto";
import { test as base } from "vitest";
import { ADMIN_URL, ROLE_PASSWORD, ROLES, runAsAdmin } from "./roles.ts";

type PostgresFixtures = { databaseUrl: string; readerUrl: string };

// Returns ADMIN_URL changed to connect as `role` to `database`.
function urlFor(role: string, database: string): string {
  const url = new URL(ADMIN_URL);
  url.username = role;
  url.password = ROLE_PASSWORD;
  url.pathname = `/${database}`;

  return url.toString();
}

/**
 * Extends Vitest's `test` with two fixtures that connect to the same empty database. `databaseUrl`
 * creates the database the first time a test in the file asks for it, and the file's other tests
 * share it. When the file finishes, `databaseUrl` drops the database and closes any connections
 * that are still open.
 *
 * - `databaseUrl` connects as the owner role, which owns the database and isn't a superuser.
 * - `readerUrl` connects to the same database as the read-only reader role.
 */
export const test = base.extend<PostgresFixtures>({
  databaseUrl: [
    async ({}, use) => {
      // This fixture generates the name, so it's safe to put in the statement directly.
      const name = `airway_test_${randomUUID().replaceAll("-", "")}`;
      await runAsAdmin(`create database ${name} owner ${ROLES.owner}`);

      try {
        await use(urlFor(ROLES.owner, name));
      } finally {
        await runAsAdmin(`drop database ${name} with (force)`);
      }
    },
    { scope: "file" },
  ],
  readerUrl: [
    async ({ databaseUrl }, use) => {
      await use(urlFor(ROLES.reader, new URL(databaseUrl).pathname.slice(1)));
    },
    { scope: "file" },
  ],
});
