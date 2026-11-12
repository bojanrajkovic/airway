import {
  DEFAULT_LIMIT,
  instant,
  type Filter,
  type QuerySpec,
  type QuerySpecInput,
} from "./spec.ts";

type Value = number | string | boolean;

/**
 * Rewrites a timestamp in UTC, so `02:00-04:00` and `06:00Z` become the same text. Any other value
 * comes back unchanged. Dates and enum values never look like timestamps, because they have no
 * time or offset.
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
 * Rewrites one filter in canonical form. Its timestamps go to UTC, and an `in` or `not-in` list is
 * sorted and loses its repeats.
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
 * Drops each clause that's the same as an earlier one, keeping the first. A filter or having
 * written twice filters nothing more than it does once.
 */
const distinct = <Clause>(clauses: readonly Clause[]): Clause[] => [
  ...new Map(clauses.map((clause) => [JSON.stringify(clause), clause])).values(),
];

/**
 * Rewrites a spec so that two specs asking the same thing come out identical, and so share a link
 * and a short code. The result:
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
    ...(calculations.length === 1 && calculations[0]?.op === "COUNT"
      ? {}
      : {
          calculations: calculations.map((calculation) =>
            calculation.op === "COUNT"
              ? { op: calculation.op }
              : { op: calculation.op, column: calculation.column },
          ),
        }),
    ...(filters.length === 0 ? {} : { filters }),
    // OR and AND give the same rows when there are fewer than two filters, so OR is left out too.
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

/** The canonical spec as compact JSON. Links carry this text, and short codes hash it. */
export function canonicalJson(spec: QuerySpec): string {
  return JSON.stringify(canonicalize(spec));
}
