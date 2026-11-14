import { randomUUID } from "node:crypto";
import { test as base } from "vitest";
import { ADMIN_URL, ROLE_PASSWORD, ROLES, runAsAdmin } from "./roles.ts";

type PostgresFixtures = { databaseUrl: string; readerUrl: string };

// ADMIN_URL's host, with another role and database.
function urlFor(role: string, database: string): string {
  const url = new URL(ADMIN_URL);
  url.username = role;
  url.password = ROLE_PASSWORD;
  url.pathname = `/${database}`;

  return url.toString();
}

/**
 * Vitest's `test`, plus two fixtures for an empty database that's created the first time a test in
 * the file asks for it, shared by the file's other tests, and dropped (closing any connections
 * still open) when the file finishes:
 *
 * - `databaseUrl` connects as the owner role, which owns the database and isn't a superuser.
 * - `readerUrl` connects to the same database as the read-only reader role.
 */
export const test = base.extend<PostgresFixtures>({
  databaseUrl: [
    async ({}, use) => {
      // The name is ours, never input, so it's safe to put in the statement directly.
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
