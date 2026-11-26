import type { Column } from "../registry/define.ts";
import type { Granularity } from "../query/spec.ts";
import type { ColumnUnit } from "../registry/units.ts";

/** Caps the number of rows in a query result on the web. */
export const WEB_ROW_LIMIT = 10_000;

/** Resolves to the types that one value in a result can have. A missing value is null. */
export type Cell = number | string | boolean | Temporal.Instant | Temporal.PlainDate | null;

/** Describes a breakdown or a calculation of the query, in the order that its values appear. */
export type ResultColumn = {
  /** Breakdowns are numbered `b0`, `b1`, and so on, then calculations `c0`, `c1`. */
  key: string;
  /** `label` is the column's name, or the calculation as written, such as `P95(leak)`. */
  label: string;
  kind: Column["kind"];
  /** `unit` is the display unit of a metric's values. */
  unit?: ColumnUnit;
};

/**
 * Describes one combination of breakdown values, with each calculation computed over the whole
 * night range.
 */
export type Group = {
  /** `rank` is 1 for the first group in the query's order. */
  rank: number;
  /** `breakdowns` contains one value per breakdown. */
  breakdowns: Cell[];
  /** `totals` contains one value per calculation. */
  totals: Cell[];
};

/** Describes one group's calculations in one time bucket. */
export type SeriesRow = {
  /**
   * `bucket` is the bucket's start. It's an instant when the step is shorter than a night, and a
   * date otherwise.
   */
  bucket: Temporal.Instant | Temporal.PlainDate;
  /** `group` is the `rank` of the row's group. */
  group: number;
  /** `values` contains one value per calculation. */
  values: Cell[];
};

/** Describes the result of a builder query. Numbers are in display units. */
export type QueryResult = {
  columns: ResultColumn[];
  /**
   * The groups are ranked in the query's order. A query with no breakdowns has exactly one
   * group.
   */
  groups: Group[];
  /** The server sets `series` only when the query has a granularity. */
  series?: {
    /**
     * `granularity` is the step that buckets the rows. It's the spec's granularity, or the
     * granularity that `auto` picked.
     */
    granularity: Granularity;
    /** The rows are sorted by group rank, then by time. */
    rows: SeriesRow[];
  };
  /**
   * `truncated` is true when there were more groups than the limit, or more series rows than the
   * web limit.
   */
  truncated: boolean;
};
