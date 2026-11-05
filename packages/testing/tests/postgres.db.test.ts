import pg from "pg";
import { expect } from "vitest";
import { z } from "zod";
import { test } from "../src/postgres.ts";

const Row = z.object({
  database: z.string(),
  version: z.coerce.number(),
  tables: z.coerce.number(),
});

test("gives the file its own empty Postgres 18 database", async ({ databaseUrl }) => {
  const client = new pg.Client(databaseUrl);
  await client.connect();

  try {
    const result = await client.query(
      `select current_database() as database,
              current_setting('server_version_num') as version,
              (select count(*) from pg_tables where schemaname = 'public') as tables`,
    );
    const row = Row.parse(result.rows[0]);

    expect(row.database).toMatch(/^airway_test_[0-9a-f]{32}$/v);
    expect(row.version).toBeGreaterThanOrEqual(180_000);
    expect(row.version).toBeLessThan(190_000);
    expect(row.tables).toBe(0);
  } finally {
    await client.end();
  }
});
