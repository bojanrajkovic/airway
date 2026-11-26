import {
  CalculationOp,
  DEFAULT_LIMIT,
  instant,
  type Filter,
  type QuerySpec,
  type QuerySpecInput,
} from "./spec.ts";

type Value = number | string | boolean;

/**
 * Rewrites a timestamp in UTC, so `02:00-04:00` and `06:00Z` become the same text. Any other value
 * comes back unchanged. Only text with a time and an offset parses as a timestamp, so dates and
 * enum values stay as written.
 */
const sameInstantInUtc = <Scalar extends Value>(value: Scalar): Scalar | string =>
  typeof value === "string" && instant.safeParse(value).success
    ? Temporal.Instant.from(value).toString()
    : value;

/** Sorts numbers, text, and booleans in ascending order, for `toSorted`. */
function ascending(one: Value, other: Value): number {
  if (one === other) {
    return 0;
  }

  return one < other ? -1 : 1;
}

type ListFilter = Extract<Filter, { value: unknown[] }>;
const hasList = (filter: Filter): filter is ListFilter =>
  "value" in filter && Array.isArray(filter.value);

/**
 * Rewrites one filter in canonical form. It writes each timestamp in UTC, and it sorts an `in` or
 * `not-in` list and drops the repeats.
 */
function canonicalFilter(filter: Filter): Filter {
  const { column } = filter;

  if (!("value" in filter)) {
    return { column, op: filter.op };
  }

  if (hasList(filter)) {
    const value = [...new Set(filter.value.map(sameInstantInUtc))].toSorted(ascending);

    return { column, op: filter.op, value };
  }

  return { column, op: filter.op, value: sameInstantInUtc(filter.value) };
}

/**
 * Drops each clause that's the same as an earlier one, keeping the first. Repeating a filter or
 * having doesn't change which rows match.
 */
const distinct = <Clause>(clauses: readonly Clause[]): Clause[] => [
  ...new Map(clauses.map((clause) => [JSON.stringify(clause), clause])).values(),
];

/**
 * Rewrites a spec so that equivalent specs produce the same JSON. `canonicalize`:
 *
 * - writes keys in a fixed order
 * - leaves out every field that equals its default
 * - sorts each `in` and `not-in` list and drops its repeats
 * - writes every timestamp in UTC
 * - drops a filter or having that repeats an earlier one
 *
 * Calculations, filters, breakdowns, orders, and havings keep the order they were written in,
 * because the builder's rows and the charts follow that order.
 */
export function canonicalize(spec: QuerySpec): QuerySpecInput {
  const { nights, calculations, breakdowns, orders, havings } = spec;
  const filters = distinct(spec.filters.map(canonicalFilter));

  return {
    v: spec.v,
    dataset: spec.dataset,
    nights: "last" in nights ? { last: nights.last } : { from: nights.from, to: nights.to },
    ...(calculations.length === 1 && calculations[0]?.op === CalculationOp.Count
      ? {}
      : {
          calculations: calculations.map((calculation) =>
            calculation.op === CalculationOp.Count
              ? { op: calculation.op }
              : { op: calculation.op, column: calculation.column },
          ),
        }),
    ...(filters.length === 0 ? {} : { filters }),
    // With a single filter, OR matches the same rows as AND, so OR is left out too.
    ...(spec.filter_combination === "AND" || filters.length < 2
      ? {}
      : { filter_combination: spec.filter_combination }),
    ...(breakdowns.length === 0 ? {} : { breakdowns: [...breakdowns] }),
    ...(orders.length === 0
      ? {}
      : {
          orders: orders.map(({ op, column, order }) => ({
            ...(op === undefined ? {} : { op }),
            ...(column === undefined ? {} : { column }),
            ...(order === "descending" ? {} : { order }),
          })),
        }),
    ...(havings.length === 0
      ? {}
      : {
          havings: distinct(
            havings.map(({ calculate_op, column, op, value }) => ({
              calculate_op,
              ...(column === undefined ? {} : { column }),
              op,
              value: sameInstantInUtc(value),
            })),
          ),
        }),
    ...(spec.limit === DEFAULT_LIMIT ? {} : { limit: spec.limit }),
    ...(spec.granularity === undefined ? {} : { granularity: spec.granularity }),
  };
}

/**
 * Returns the canonical spec as compact JSON. A link contains this text, and a short code is a hash
 * of it.
 */
export function canonicalJson(spec: QuerySpec): string {
  return JSON.stringify(canonicalize(spec));
}
