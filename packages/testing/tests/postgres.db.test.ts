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

const Role = z.object({
  role: z.string(),
  superuser: z.boolean(),
  owns: z.boolean(),
  readOnly: z.string(),
  searchPath: z.string(),
  workMem: z.string(),
  tempFileLimit: z.string(),
  memberOfReader: z.boolean(),
});

async function role(url: string): Promise<z.infer<typeof Role>> {
  const client = new pg.Client(url);
  await client.connect();

  try {
    const result = await client.query(
      `select current_user as role,
              (select rolsuper from pg_roles where rolname = current_user) as superuser,
              (select pg_get_userbyid(datdba) = current_user from pg_database
               where datname = current_database()) as owns,
              current_setting('default_transaction_read_only') as "readOnly",
              current_setting('search_path') as "searchPath",
              current_setting('work_mem') as "workMem",
              current_setting('temp_file_limit') as "tempFileLimit",
              pg_has_role(current_user, 'airway_reader', 'member') as "memberOfReader"`,
    );

    return Role.parse(result.rows[0]);
  } finally {
    await client.end();
  }
}

test("connects as an owner that isn't a superuser and belongs to the reader role", async ({
  databaseUrl,
}) => {
  expect(await role(databaseUrl)).toMatchObject({
    role: "airway_owner",
    superuser: false,
    owns: true,
    readOnly: "off",
    memberOfReader: true,
  });
});

test("gives the reader the deployment's settings", async ({ readerUrl }) => {
  expect(await role(readerUrl)).toMatchObject({
    role: "airway_reader",
    superuser: false,
    owns: false,
    readOnly: "on",
    searchPath: "derived",
    workMem: "64MB",
    tempFileLimit: "1GB",
  });
});
