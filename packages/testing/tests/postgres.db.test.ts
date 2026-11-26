import pg from "pg";
import { expect } from "vitest";
import { z } from "zod";
import { test } from "../src/postgres.ts";

const Row = z.object({
  database: z.string(),
  tables: z.coerce.number(),
});

test("gives the file its own empty database", async ({ databaseUrl }) => {
  const client = new pg.Client(databaseUrl);
  await client.connect();

  try {
    const result = await client.query(
      `select current_database() as database,
              (select count(*) from pg_tables where schemaname = 'public') as tables`,
    );
    const row = Row.parse(result.rows[0]);

    expect(row.database).toMatch(/^airway_test_[0-9a-f]{32}$/v);
    expect(row.tables).toBe(0);
  } finally {
    await client.end();
  }
});
