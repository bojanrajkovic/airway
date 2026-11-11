import type { Column } from "../registry/define.ts";
import type { Granularity } from "../query/spec.ts";
import type { ColumnUnit } from "../registry/units.ts";

/** The most rows a web result carries: a builder query's series, or a SQL result. */
export const WEB_ROW_LIMIT = 10_000;

/** One value in a result. Empty is null. */
export type Cell = number | string | boolean | Temporal.Instant | Temporal.PlainDate | null;

/** A breakdown or a calculation of the query, in the order its values appear. */
export type ResultColumn = {
  /** `b0`, `b1` for breakdowns, then `c0`, `c1` for calculations. */
  key: string;
  /** The column's name, or the calculation as written: `P95(leak)`. */
  label: string;
  kind: Column["kind"];
  /** The display unit of a metric's values. Absent for a machine signal before the first import. */
  unit?: ColumnUnit;
};

/** One combination of breakdown values, with each calculation over the whole night range. */
export type Group = {
  /** 1 for the first group in the query's order. */
  rank: number;
  /** One value per breakdown. */
  breakdowns: Cell[];
  /** One value per calculation. */
  totals: Cell[];
};

/** One group's calculations in one time bucket. */
export type SeriesRow = {
  /** Where the bucket starts: an instant for steps under a night, and a date from `night` up. */
  bucket: Temporal.Instant | Temporal.PlainDate;
  /** The group's rank. */
  group: number;
  /** One value per calculation. */
  values: Cell[];
};

/** What a builder query returns. Numbers are in display units. */
export type QueryResult = {
  columns: ResultColumn[];
  /** In the query's order. A query with no breakdowns has one group. */
  groups: Group[];
  /** Only for a query with a granularity. */
  series?: {
    /** The step the rows are bucketed by: the spec's, or the one `auto` picked. */
    granularity: Granularity;
    /** In group order, then time order. */
    rows: SeriesRow[];
  };
  /** True when there were more groups than the limit, or more series rows than the web limit. */
  truncated: boolean;
};
