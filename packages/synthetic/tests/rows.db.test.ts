import pg from "pg";
import { expect } from "vitest";
import { z } from "zod";
import { ClockOffsets } from "@airway/contract/clock";
import { derivedTables } from "@airway/contract/derived/ddl";
import { test } from "@airway/testing/postgres";
import { syntheticNights } from "../src/model.ts";
import { synthesize } from "../src/synthesize.ts";

const offsets = ClockOffsets.parse([{ from: "2030-01-01", utcOffset: "-05:00" }]);
const Columns = z.array(z.object({ table: z.string(), column: z.string() }));

// A row's column names, with the machine-signal columns under `signals` spread out.
const columnsOf = (row: object): string[] =>
  Object.entries(row).flatMap(([key, value]: [string, unknown]) =>
    key === "signals" && typeof value === "object" && value !== null ? Object.keys(value) : [key],
  );

// rows.ts and ddl.ts both list every derived column. A column one leaves out would otherwise load
// as null without an error.
test("gives every derived table's rows exactly the table's columns", async ({ databaseUrl }) => {
  const [first, second] = syntheticNights({ seed: 7, nights: 2 })._unsafeUnwrap().nights;

  if (first === undefined || second === undefined) {
    throw new Error("expected two nights");
  }

  // A changed setting, so settings_changes has a row too.
  const raised = { ...second, str: new Map(second.str).set("S.AS.MaxPress", 14) };
  const { rows } = synthesize([first, raised], offsets, {
    patient: "child",
    arrivedAt: Temporal.Instant.from("2030-03-01T12:00:00Z"),
  })._unsafeUnwrap();

  const client = new pg.Client(databaseUrl);
  await client.connect();

  const tables = await (async () => {
    try {
      await client.query(derivedTables("derived"));
      const result = await client.query(
        `select table_name as table, column_name as column from information_schema.columns
         where table_schema = 'derived'`,
      );

      return Columns.parse(result.rows);
    } finally {
      await client.end();
    }
  })();

  for (const [table, list] of Object.entries(rows)) {
    const [row] = list;

    expect(row, table).toBeDefined();
    expect(new Set(columnsOf(row ?? {})), table).toEqual(
      new Set(tables.filter((entry) => entry.table === table).map((entry) => entry.column)),
    );
  }

  // Every derived table has rows here, except the two a load computes.
  expect(new Set(tables.map((entry) => entry.table))).toEqual(
    new Set([...Object.keys(rows), "meta", "period_percentiles"]),
  );
});
