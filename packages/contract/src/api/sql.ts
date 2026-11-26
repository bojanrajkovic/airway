import type { Cell } from "./query.ts";

/** Classifies a result column's values as far as a table or a chart needs to know. */
export type SqlKind = "number" | "boolean" | "timestamp" | "date" | "text";

/**
 * Describes a SQL statement's result in the web app, with at most `WEB_ROW_LIMIT` rows in stored
 * units.
 */
export type SqlResult = {
  columns: { name: string; kind: SqlKind }[];
  /** Each row contains one value per column. */
  rows: Cell[][];
  /** `truncated` is true when the statement had more rows than the limit. */
  truncated: boolean;
};
