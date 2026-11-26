import type { Column } from "../registry/define.ts";
import type { Granularity } from "../query/spec.ts";
import type { ColumnUnit } from "../registry/units.ts";

/** The maximum number of rows in a query result on the web. */
export const WEB_ROW_LIMIT = 10_000;

/** One value in a result. A missing value is null. */
export type Cell = number | string | boolean | Temporal.Instant | Temporal.PlainDate | null;

/** A breakdown or a calculation of the query, in the order its values appear. */
export type ResultColumn = {
  /** Breakdowns are numbered `b0`, `b1`, and so on, then calculations `c0`, `c1`. */
  key: string;
  /** The column's name, or the calculation as written, such as `P95(leak)`. */
  label: string;
  kind: Column["kind"];
  /** The display unit of a metric's values. */
  unit?: ColumnUnit;
};

/** One combination of breakdown values, with each calculation computed over the whole night range. */
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
  /** Where the bucket starts. It's an instant when the step is shorter than a night, and a date otherwise. */
  bucket: Temporal.Instant | Temporal.PlainDate;
  /** The group's rank. */
  group: number;
  /** One value per calculation. */
  values: Cell[];
};

/** What a builder query returns. Numbers are in display units. */
export type QueryResult = {
  columns: ResultColumn[];
  /** Ranked in the query's order. A query with no breakdowns has exactly one group. */
  groups: Group[];
  /** Present only when the query has a granularity. */
  series?: {
    /** The step that buckets the rows. It's the spec's granularity, or the granularity that `auto` picked. */
    granularity: Granularity;
    /** Sorted by group rank, then by time. */
    rows: SeriesRow[];
  };
  /** True when there were more groups than the limit, or more series rows than the web limit. */
  truncated: boolean;
};
