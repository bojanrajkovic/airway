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
import { periodPercentiles } from "@airway/contract/derived/percentiles";
import type { DerivedRows, SignalValues } from "@airway/contract/derived/rows";

export type LoadOptions = {
  /** Defaults to `derived`, the schema queries read. */
  schema?: DerivedSchema;
  /** Stands in for the time the schema was built, in `meta`. */
  builtAt: Temporal.Instant;
};

// The reader role in the database tests and in .env.example.
const READER = "airway_reader";

const BATCH_ROWS = 5000;

// Parents first, so every foreign key finds its row.
const ORDER = [
  "device",
  "column_units",
  "daily_usage",
  "settings_changes",
  "nights",
  "files",
  "sessions",
  "segments",
  "events",
  "samples",
  "breaths",
] as const satisfies readonly (keyof DerivedRows)[];

type Cell = string | number | boolean | null | Temporal.Instant | Temporal.PlainDate;
/** Any derived row: its columns, with machine-signal columns grouped under `signals`. */
type Row = Readonly<Record<string, Cell | SignalValues>>;

const isSignals = (value: Cell | SignalValues): value is SignalValues =>
  typeof value === "object" &&
  value !== null &&
  !(value instanceof Temporal.Instant) &&
  !(value instanceof Temporal.PlainDate);

// A value in COPY's text format. Strings escape backslashes, tabs, and newlines, which COPY treats
// as separators.
function text(cell: Cell, decimals: number | undefined): string {
  if (cell === null) {
    return "\\N";
  }

  if (typeof cell === "boolean") {
    return cell ? "t" : "f";
  }

  if (typeof cell === "number") {
    // A signal value goes in as the decimal text ingest writes, so `leak = 0.4` matches it.
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

// A row's columns and values. A `signals` field holds machine-signal columns by name.
function cells(row: Row): [string, Cell][] {
  return Object.entries(row).flatMap(([key, value]): [string, Cell][] =>
    isSignals(value) ? Object.entries(value) : [[key, value]],
  );
}

type Target = { schema: DerivedSchema; table: string; rows: readonly Row[] };

async function copy(
  client: pg.Client,
  { schema, table, rows }: Target,
  decimals: ReadonlyMap<string, number>,
): Promise<void> {
  const [first] = rows;

  if (first === undefined) {
    return;
  }

  const columns = cells(first).map(([column]) => column);
  const places = columns.map((column) => decimals.get(`${table}.${column}`));
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

/**
 * Creates `schema` and loads `rows` into it with COPY, in one transaction. It then builds the
 * indexes and the `samples` and `breaths` foreign keys, fills `period_percentiles` with the shared
 * statement, stamps `meta`, and grants the reader role SELECT. Throws on any error, after rolling
 * back, so a test fails with Postgres's message.
 */
export async function loadDerived(
  client: pg.Client,
  rows: DerivedRows,
  { schema = "derived", builtAt }: LoadOptions,
): Promise<void> {
  const decimals = new Map(
    rows.column_units.map((unit) => [`${unit.dataset}.${unit.column_name}`, unit.decimals]),
  );

  await client.query("begin");

  try {
    await client.query(derivedTables(schema));

    for (const table of ORDER) {
      await copy(client, { schema, table, rows: rows[table] }, decimals);
    }

    await client.query(derivedIndexesAndKeys(schema));
    await client.query(periodPercentiles(schema));
    await client.query(`insert into ${schema}.meta (derived_version, built_at) values ($1, $2)`, [
      DERIVED_VERSION,
      builtAt.toString(),
    ]);
    await client.query(
      `grant usage on schema ${schema} to ${READER};
       grant select on all tables in schema ${schema} to ${READER};`,
    );

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");

    throw error;
  }
}
