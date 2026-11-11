import type { Cell } from "./query.ts";

/** What a result column holds, as far as a table or a chart needs to know. */
export type SqlKind = "number" | "boolean" | "timestamp" | "date" | "text";

/** What a SQL statement returns in the web app: at most `WEB_ROW_LIMIT` rows, in stored units. */
export type SqlResult = {
  columns: { name: string; kind: SqlKind }[];
  /** One value per column. */
  rows: Cell[][];
  /** True when the statement had more rows than the limit. */
  truncated: boolean;
};
