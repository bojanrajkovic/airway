import { test } from "@airway/testing/postgres";
import pg from "pg";
import { expect } from "vitest";
import { derivedIndexesAndKeys, derivedTables } from "../../src/derived/ddl.ts";
import { DATASETS } from "../../src/registry/datasets.ts";
import { render, type Column } from "../../src/registry/define.ts";
import { withClient } from "../support/postgres.ts";

// The Postgres types a column of each kind may have. A numeric would reach the caller as a string.
const { FLOAT8, INT2, INT4, BOOL, TIMESTAMPTZ, DATE, TEXT } = pg.types.builtins;
const TYPES: Record<Column["kind"], readonly number[]> = {
  number: [FLOAT8, INT4],
  integer: [INT2, INT4],
  boolean: [BOOL],
  timestamp: [TIMESTAMPTZ],
  date: [DATE],
  enum: [TEXT],
};

test.for(DATASETS)(
  "every $name column's SQL runs against its table, and gives its kind's type",
  async ({ name, columns }, { databaseUrl }) => {
    await withClient(databaseUrl, async (client) => {
      // Rolled back, so each dataset's test creates the tables for itself.
      await client.query("begin");
      await client.query(derivedTables("derived") + derivedIndexesAndKeys("derived"));

      const selected = columns.map(
        ({ name: column, sql }, index) =>
          `${sql === undefined ? pg.escapeIdentifier(column) : render(sql, { homeZone: 1 })} as c${index.toFixed(0)}`,
      );
      // The filter uses $1 in every statement, so the zone binds even where no column needs it.
      const statement = `select ${selected.join(", ")} from derived.${name} where $1::text is not null`;
      const result = await client.query(statement, ["America/Chicago"]);
      await client.query("rollback");

      const mistyped = columns.filter(
        ({ kind }, index) => !TYPES[kind].includes(result.fields[index]?.dataTypeID ?? 0),
      );

      expect(mistyped.map((column) => column.name)).toEqual([]);
    });
  },
);
