// Random valid specs, built from the registry, for property tests of everything that takes one.
import fc from "fast-check";
import { DATASETS } from "../registry/datasets.ts";
import {
  COMPARISONS,
  MEMBERSHIP,
  NULL_CHECKS,
  operationsFor,
  type Column,
  type Dataset,
} from "../registry/define.ts";
import {
  CALCULATION_OPS,
  LIMITS,
  calculationKind,
  calculationLabel,
  columnsFor,
  granularitiesFor,
  parseSpec,
  type Calculation,
  type Filter,
  type QuerySpec,
  type QuerySpecInput,
} from "./spec.ts";

const moment = fc.date({
  min: new Date("2020-01-01T00:00:00Z"),
  max: new Date("2035-12-31T23:59:59Z"),
  noInvalidDate: true,
});
const instant = moment.map((value) => value.toISOString());
const date = instant.map((text) => text.slice(0, 10));
// JSON writes -0 as 0, so a spec holding -0 wouldn't survive a link.
const number = fc
  .double({ noNaN: true, noDefaultInfinity: true })
  .map((value) => (value === 0 ? 0 : value));
const VALUES = { number, integer: fc.maxSafeInteger(), timestamp: instant, date };

function valueOf(column: Column): fc.Arbitrary<number | string | boolean> {
  if (column.kind === "boolean") {
    return fc.boolean();
  }

  return column.kind === "enum" ? fc.constantFrom(...column.values) : VALUES[column.kind];
}

const isOneOf = <Value extends string>(values: readonly Value[], value: string): value is Value =>
  values.some((one) => one === value);

function filterOf(column: Column): fc.Arbitrary<Filter> {
  const { name } = column;

  return fc.constantFrom(...operationsFor(column)).chain((op): fc.Arbitrary<Filter> => {
    if (isOneOf(NULL_CHECKS, op)) {
      return fc.constant({ column: name, op });
    }

    return isOneOf(MEMBERSHIP, op)
      ? fc
          .array(valueOf(column), { minLength: 1, maxLength: LIMITS.list })
          .map((value) => ({ column: name, op, value }))
      : valueOf(column).map((value) => ({ column: name, op, value }));
  });
}

function calculationOf(dataset: Dataset): fc.Arbitrary<Calculation> {
  return fc
    .constantFrom(...CALCULATION_OPS)
    .chain((op): fc.Arbitrary<Calculation> =>
      op === "COUNT"
        ? fc.constant({ op })
        : fc.constantFrom(...columnsFor(dataset, op)).map((column) => ({ op, column })),
    );
}

const direction = fc.option(fc.constantFrom("ascending" as const, "descending" as const), {
  nil: undefined,
});

/** Orders and havings that name the given calculations and breakdowns. */
function references(
  dataset: Dataset,
  calculations: readonly Calculation[],
  breakdowns: readonly string[],
): fc.Arbitrary<Pick<QuerySpecInput, "orders" | "havings">> {
  const orderable = [...calculations, ...breakdowns.map((column) => ({ column }))];
  const orders = fc
    .shuffledSubarray(orderable)
    .chain((chosen) =>
      fc.tuple(
        ...chosen.map((reference) =>
          direction.map((order) => (order === undefined ? reference : { ...reference, order })),
        ),
      ),
    );
  const having = fc
    .constantFrom(...calculations)
    .chain(({ op, ...column }) =>
      fc
        .tuple(fc.constantFrom(...COMPARISONS), VALUES[calculationKind(dataset, { op, ...column })])
        .map(([comparison, value]) => ({ calculate_op: op, ...column, op: comparison, value })),
    );

  return fc.record(
    { orders, havings: fc.array(having, { maxLength: LIMITS.havings }) },
    { requiredKeys: [] },
  );
}

function specOf(dataset: Dataset): fc.Arbitrary<QuerySpecInput> {
  const groupable = dataset.columns.filter(({ role }) => role !== "metric").map(({ name }) => name);
  const filter = fc.constantFrom(...dataset.columns).chain(filterOf);
  const clauses = fc.record(
    {
      v: fc.constant(1 as const),
      dataset: fc.constant(dataset.name),
      nights: fc.oneof(
        fc.record({ last: fc.integer({ min: 1, max: LIMITS.last }) }),
        fc.tuple(date, date).map(([one, other]) => ({
          from: one < other ? one : other,
          to: one < other ? other : one,
        })),
      ),
      calculations: fc.uniqueArray(calculationOf(dataset), {
        minLength: 1,
        maxLength: LIMITS.calculations,
        selector: calculationLabel,
      }),
      filters: fc.array(filter, { maxLength: LIMITS.filters }),
      filter_combination: fc.constantFrom("AND" as const, "OR" as const),
      breakdowns: fc.shuffledSubarray(groupable, { maxLength: LIMITS.breakdowns }),
      limit: fc.integer({ min: 1, max: LIMITS.limit }),
      granularity: fc.constantFrom(...granularitiesFor(dataset)),
    },
    { requiredKeys: ["v", "dataset", "nights"] },
  );

  return clauses.chain((spec) =>
    references(dataset, spec.calculations ?? [{ op: "COUNT" }], spec.breakdowns ?? []).map(
      (named) => ({ ...spec, ...named }),
    ),
  );
}

/** A valid spec as a person or an agent might write it, with any optional part left out. */
export const specInput: fc.Arbitrary<QuerySpecInput> = fc.oneof(...DATASETS.map(specOf));

/** A valid parsed spec. */
export const spec: fc.Arbitrary<QuerySpec> = specInput.map((input) =>
  parseSpec(input).match(
    (parsed) => parsed,
    (issues) => {
      throw new Error(`the generator wrote an invalid spec: ${JSON.stringify(issues)}`);
    },
  ),
);
