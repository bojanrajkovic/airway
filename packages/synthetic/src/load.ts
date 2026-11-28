import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import {
  DERIVED_VERSION,
  derivedIndexesAndKeys,
  derivedTables,
  type DerivedSchema,
} from "@airway/contract/derived/ddl";
import { rebuildAllPercentiles } from "@airway/contract/derived/percentiles";
import type { DerivedRows, SignalValues } from "@airway/contract/derived/rows";
import { COLUMN_UNITS } from "@airway/edf/columns";

export type LoadOptions = {
  /** Defaults to `derived`, the schema that queries read. */
  schema?: DerivedSchema;
  /** `meta` records this instant as the time the schema was built. */
  builtAt: Temporal.Instant;
};

const BATCH_ROWS = 5000;

const DECIMALS: ReadonlyMap<string, number> = new Map(
  COLUMN_UNITS.map((unit) => [`${unit.dataset}.${unit.column_name}`, unit.decimals]),
);

// Parent tables load first, so each foreign key references an existing row.
const ORDER = [
  "device",
  "daily_usage",
  "settings_changes",
  "nights",
  "sessions",
  "segments",
  "files",
  "events",
  "samples",
  "breaths",
] as const satisfies readonly (keyof DerivedRows)[];

type Cell = string | number | boolean | null | Temporal.Instant | Temporal.PlainDate;
/** Matches any row in `DerivedRows`. */
type Row = Readonly<Record<string, Cell | SignalValues>>;

const isSignals = (value: Cell | SignalValues): value is SignalValues =>
  typeof value === "object" &&
  value !== null &&
  !(value instanceof Temporal.Instant) &&
  !(value instanceof Temporal.PlainDate);

// Returns `cell` in COPY's text format. In a string, it escapes backslashes, tabs, and newlines,
// because COPY treats those characters as special.
function text(cell: Cell, decimals: number | undefined): string {
  if (cell === null) {
    return "\\N";
  }

  if (typeof cell === "boolean") {
    return cell ? "t" : "f";
  }

  if (typeof cell === "number") {
    // Writes a signal value with ingest's number of decimals, so `leak = 0.4` matches the value.
    return decimals === undefined ? String(cell) : cell.toFixed(decimals);
  }

  if (typeof cell === "string") {
    return cell.replace(
      /[\\\t\n\r]/gv,
      (c) => ({ "\t": "\\t", "\n": "\\n", "\r": "\\r" })[c] ?? "\\\\",
    );
  }

  return cell.toString();
}

// Returns the name and value of each column in `row`, including the columns inside `signals`.
function cells(row: Row): [string, Cell][] {
  return Object.entries(row).flatMap(([key, value]): [string, Cell][] =>
    isSignals(value) ? Object.entries(value) : [[key, value]],
  );
}

type Target = { schema: DerivedSchema; table: string; rows: readonly Row[] };

async function copy(client: pg.Client, { schema, table, rows }: Target): Promise<void> {
  const [first] = rows;

  if (first === undefined) {
    return;
  }

  const columns = cells(first).map(([column]) => column);
  const places = columns.map((column) => DECIMALS.get(`${table}.${column}`));
  // Rows go out in batches, because a stream chunk per row costs more than the row itself.
  const batches = function* (): Generator<string> {
    for (let start = 0; start < rows.length; start += BATCH_ROWS) {
      yield rows
        .slice(start, start + BATCH_ROWS)
        .map(
          (row) =>
            `${cells(row)
              .map(([, cell], i) => text(cell, places[i]))
              .join("\t")}\n`,
        )
        .join("");
    }
  };

  await pipeline(
    Readable.from(batches()),
    client.query(copyFrom(`copy ${schema}.${table} (${columns.join(", ")}) from stdin`)),
  );
}

/** Creates `schema` and loads `rows` in one transaction. docs/synthetic-data.md lists each step. */
export async function loadDerived(
  client: pg.Client,
  rows: DerivedRows,
  { schema = "derived", builtAt }: LoadOptions,
): Promise<void> {
  await client.query("begin");

  try {
    await client.query(derivedTables(schema));

    for (const table of ORDER) {
      await copy(client, { schema, table, rows: rows[table] });
    }

    await client.query(derivedIndexesAndKeys(schema));
    await client.query(rebuildAllPercentiles(schema));
    await client.query(`insert into ${schema}.meta (derived_version, built_at) values ($1, $2)`, [
      DERIVED_VERSION,
      builtAt.toString(),
    ]);

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");

    throw error;
  }
}
