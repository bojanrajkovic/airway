import {
  DEFAULT_LIMIT,
  instant,
  type Filter,
  type QuerySpec,
  type QuerySpecInput,
} from "./spec.ts";

type Value = number | string | boolean;

// Text is a time only when it carries a time and an offset, which no date or enum value does.
const sameInstantInUtc = <Scalar extends Value>(value: Scalar): Scalar | string =>
  typeof value === "string" && instant.safeParse(value).success
    ? Temporal.Instant.from(value).toString()
    : value;

function ascending(one: Value, other: Value): number {
  if (one === other) {
    return 0;
  }

  return one < other ? -1 : 1;
}

type ListFilter = Extract<Filter, { value: unknown[] }>;
const hasList = (filter: Filter): filter is ListFilter =>
  "value" in filter && Array.isArray(filter.value);

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

// The first of each: a filter or having written twice asks nothing more than once.
const distinct = <Clause>(clauses: readonly Clause[]): Clause[] => [
  ...new Map(clauses.map((clause) => [JSON.stringify(clause), clause])).values(),
];

/**
 * The one spelling of a query: keys in a fixed order, defaults left out, each `in` list sorted
 * without repeats, each time in UTC, and a repeated filter or having written once. Two specs that ask the same thing give the same JSON, so
 * they share a link and a short code. Clauses keep the order they were written in, because that's
 * the order of the builder's rows and the charts.
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
    // With fewer than two filters there's nothing to combine, so OR asks the same as AND.
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

/** The canonical spec as compact JSON: the text that goes in a link and that a short code hashes. */
export function canonicalJson(spec: QuerySpec): string {
  return JSON.stringify(canonicalize(spec));
}
