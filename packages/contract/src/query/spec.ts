import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import { DATASETS } from "../registry/datasets.ts";
import {
  COMPARISONS,
  MEMBERSHIP,
  NULL_CHECKS,
  operationsFor,
  type Column,
  type Dataset,
} from "../registry/define.ts";

/** The time steps a query can bucket by, shortest first. */
export const GRANULARITIES = [
  "2s",
  "30s",
  "1m",
  "5m",
  "15m",
  "1h",
  "night",
  "week",
  "month",
] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/**
 * The most nights a query can cover at each step: a night, a week, a fortnight, a month, a
 * quarter, a year, and then ten years. A fine step over a long range would be millions of buckets.
 * These are chosen round spans, not worked out from `AUTO_BUCKETS`: they bound what a spec may
 * ask for, and `auto` then picks within them.
 */
export const MAX_NIGHTS: Record<Granularity, number> = {
  "2s": 1,
  "30s": 7,
  "1m": 14,
  "5m": 31,
  "15m": 92,
  "1h": 366,
  night: 3660,
  week: 3660,
  month: 3660,
};

/** A query's night range: the most recent n nights, or two dates, both included. */
export type Nights = { last: number } | { from: string; to: string };

/** How many nights a range covers. */
export function nightCount(nights: Nights): number {
  return "last" in nights
    ? nights.last
    : Temporal.PlainDate.from(nights.from).until(nights.to).days + 1;
}

/**
 * The steps a dataset allows: its grain and every longer one. Given a night range, only the steps
 * that can cover that many nights.
 */
export function granularitiesFor(dataset: Dataset, nights?: Nights): readonly Granularity[] {
  const steps = GRANULARITIES.slice(GRANULARITIES.indexOf(dataset.grain));

  return nights === undefined
    ? steps
    : steps.filter((step) => nightCount(nights) <= MAX_NIGHTS[step]);
}

export const PERCENTILES = [
  "P001",
  "P01",
  "P05",
  "P10",
  "P20",
  "P25",
  "P50",
  "P75",
  "P80",
  "P90",
  "P95",
  "P99",
  "P999",
] as const;
// Take a metric column, and give a number.
const NUMERIC = ["SUM", "AVG", ...PERCENTILES] as const;
// Take any column with an order, and give a value of that column's kind.
const EXTREMES = ["MIN", "MAX"] as const;
export const CALCULATION_OPS = ["COUNT", "COUNT_DISTINCT", ...NUMERIC, ...EXTREMES] as const;
export type CalculationOp = (typeof CALCULATION_OPS)[number];

export const LIMITS = {
  calculations: 10,
  filters: 20,
  breakdowns: 3,
  havings: 10,
  /** Values in one `in` or `not-in` list. */
  list: 50,
  /** Groups a query returns. */
  limit: 1000,
  /** Nights a query covers: ten years. */
  nights: 3660,
} as const;
export const DEFAULT_LIMIT = 100;

const TIME = "expected a time with its offset, such as 2026-06-01T02:00:00-04:00";
const readInstant = Result.fromThrowable((text: string) => Temporal.Instant.from(text));
// A time must carry its offset, so the same text always means the same instant. The second check
// turns away the few texts the format allows and Temporal can't read, such as ten decimal places.
export const instant = z.iso
  .datetime({ offset: true, error: TIME })
  .refine((text) => readInstant(text).isOk(), { error: TIME });
const date = z.iso.date();

// A union reports only its own message when no member fits, so it says what the members are.
const nights = z
  .union(
    [
      z.strictObject({ last: z.int().min(1).max(LIMITS.nights) }),
      z.strictObject({ from: date, to: date }),
    ],
    {
      error: `expected {"last": 1 to ${LIMITS.nights.toFixed(0)}} or {"from", "to"} with two dates such as 2026-06-01`,
    },
  )
  .refine((range) => "last" in range || range.from <= range.to, {
    path: ["to"],
    error: "to must not be before from",
  })
  .refine((range) => nightCount(range) <= LIMITS.nights, {
    path: ["to"],
    error: `a query covers at most ${LIMITS.nights.toFixed(0)} nights`,
  });

type Scalar = number | string | boolean;

function valueSchema(column: Column): z.ZodType<Scalar, Scalar> {
  switch (column.kind) {
    case "number": {
      return z.number();
    }

    case "integer": {
      return z.int();
    }

    case "boolean": {
      return z.boolean();
    }

    case "enum": {
      return z.enum(column.values);
    }

    case "timestamp": {
      return instant;
    }

    case "date": {
      return date;
    }
  }
}

/** A filter on one column: only the operations its kind allows, with values of its kind. */
// oxlint-disable-next-line typescript/explicit-function-return-type -- a schema's type is its definition, and the spec's types are inferred from it
function filterSchema(column: Column) {
  const allowed = operationsFor(column);
  const only = <Operation extends string>(operations: readonly Operation[]): Operation[] =>
    operations.filter((operation) => allowed.some((one) => one === operation));
  const name = z.literal(column.name);
  const value = valueSchema(column);

  const lists = only(MEMBERSHIP);

  return z.discriminatedUnion("op", [
    z.strictObject({ column: name, op: z.enum(only(COMPARISONS)), value }),
    z.strictObject({ column: name, op: z.enum(NULL_CHECKS) }),
    // Left out for a column with no list operations: an option needs at least one op.
    ...(lists.length > 0
      ? [
          z.strictObject({
            column: name,
            op: z.enum(lists),
            value: z.array(value).min(1).max(LIMITS.list),
          }),
        ]
      : []),
  ]);
}

const ORDERED_KINDS: readonly Column["kind"][] = ["number", "integer", "timestamp", "date"];
const namesOf = (columns: readonly Column[]): string[] => columns.map(({ name }) => name);
/** Narrows text to one of a fixed list of values. */
export const isOneOf = <Value extends string>(
  values: readonly Value[],
  value: string,
): value is Value => values.some((one) => one === value);

/** The columns a calculation can take. COUNT takes none. */
export function columnsFor({ columns }: Dataset, op: CalculationOp): string[] {
  if (op === "COUNT") {
    return [];
  }

  if (op === "COUNT_DISTINCT") {
    return namesOf(columns);
  }

  return namesOf(
    isOneOf(EXTREMES, op)
      ? columns.filter(({ kind }) => ORDERED_KINDS.includes(kind))
      : columns.filter(({ role }) => role === "metric"),
  );
}

// oxlint-disable-next-line typescript/explicit-function-return-type -- a schema's type is its definition, and the spec's types are inferred from it
function calculationSchema(dataset: Dataset) {
  return z.discriminatedUnion("op", [
    z.strictObject({ op: z.literal("COUNT") }),
    z.strictObject({
      op: z.literal("COUNT_DISTINCT"),
      column: z.enum(columnsFor(dataset, "COUNT_DISTINCT")),
    }),
    z.strictObject({ op: z.enum(NUMERIC), column: z.enum(columnsFor(dataset, "SUM")) }),
    z.strictObject({ op: z.enum(EXTREMES), column: z.enum(columnsFor(dataset, "MIN")) }),
  ]);
}

type CalculationReference = { op: CalculationOp; column?: string | undefined };

/** How a calculation is written in messages and column headings: `COUNT`, `P95(leak)`. */
export function calculationLabel({ op, column }: CalculationReference): string {
  return column === undefined ? op : `${op}(${column})`;
}

/** The kind of value a calculation gives: MIN and MAX give their column's kind. */
export function calculationKind(
  dataset: Dataset,
  { op, column }: CalculationReference,
): "number" | "integer" | "timestamp" | "date" {
  if (op === "COUNT" || op === "COUNT_DISTINCT") {
    return "integer";
  }

  const kind = dataset.columns.find(({ name }) => name === column)?.kind;

  return kind === "integer" || kind === "timestamp" || kind === "date" ? kind : "number";
}

/** How long each step is, in seconds. A month counts as 30 days. */
export const STEP_SECONDS: Record<Granularity, number> = {
  "2s": 2,
  "30s": 30,
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  night: 86_400,
  week: 7 * 86_400,
  month: 30 * 86_400,
};
/** The most buckets `auto` gives one group: about what a chart can show. */
export const AUTO_BUCKETS = 300;

/** The buckets one group gets at a step, if the machine ran around the clock every night. */
export const bucketCount = (nights: Nights, step: Granularity): number =>
  (nightCount(nights) * STEP_SECONDS.night) / STEP_SECONDS[step];

/**
 * The step a spec buckets by, if any. `auto` is the finest step the dataset and night range allow
 * with `nights × 86,400 ÷ step seconds ≤ AUTO_BUCKETS`. It depends only on the spec, so a link's step never
 * changes under it.
 */
export function granularityOf(
  dataset: Dataset,
  { nights, granularity }: { nights: Nights; granularity?: Granularity | "auto" | undefined },
): Granularity | undefined {
  if (granularity !== "auto") {
    return granularity;
  }

  // Ten years of months is 122 buckets, so the longest step fits any target a chart would use.
  return (
    granularitiesFor(dataset, nights).find((step) => bucketCount(nights, step) <= AUTO_BUCKETS) ??
    "month"
  );
}

const nightsText = (count: number): string =>
  count === 1 ? "1 night" : `${count.toFixed(0)} nights`;

const HAVING_VALUES = {
  number: { schema: z.number(), expected: "a number" },
  integer: { schema: z.number(), expected: "a number" },
  timestamp: { schema: instant, expected: "a time with its offset" },
  date: { schema: date, expected: "a date" },
};

// oxlint-disable-next-line typescript/explicit-function-return-type -- a schema's type is its definition, and the spec's types are inferred from it
function specSchema(dataset: Dataset) {
  const columns = z.enum(namesOf(dataset.columns));
  const [firstColumn, ...otherColumns] = dataset.columns;
  const calculation = calculationSchema(dataset);

  return z
    .strictObject({
      v: z.literal(1),
      dataset: z.literal(dataset.name),
      nights,
      calculations: z
        .array(calculation)
        .min(1)
        .max(LIMITS.calculations)
        .default([{ op: "COUNT" }]),
      filters: z
        .array(
          z.discriminatedUnion("column", [
            filterSchema(firstColumn),
            ...otherColumns.map(filterSchema),
          ]),
        )
        .max(LIMITS.filters)
        .default([]),
      filter_combination: z.enum(["AND", "OR"]).default("AND"),
      breakdowns: z
        .array(z.enum(namesOf(dataset.columns.filter(({ role }) => role !== "metric"))))
        .max(LIMITS.breakdowns)
        .default([]),
      // An order names a calculation by its op and column, or a breakdown by its column alone.
      orders: z
        .array(
          z.strictObject({
            op: z.enum(CALCULATION_OPS).optional(),
            column: columns.optional(),
            order: z.enum(["ascending", "descending"]).default("descending"),
          }),
        )
        .max(LIMITS.calculations + LIMITS.breakdowns)
        .default([]),
      havings: z
        .array(
          z.strictObject({
            calculate_op: z.enum(CALCULATION_OPS),
            column: columns.optional(),
            op: z.enum(COMPARISONS),
            value: z.union([z.number(), z.string()]),
          }),
        )
        .max(LIMITS.havings)
        .default([]),
      limit: z.int().min(1).max(LIMITS.limit).default(DEFAULT_LIMIT),
      granularity: z.enum([...granularitiesFor(dataset), "auto"]).optional(),
    })
    .superRefine((spec, context) => {
      const count = nightCount(spec.nights);

      if (
        spec.granularity !== undefined &&
        spec.granularity !== "auto" &&
        count > MAX_NIGHTS[spec.granularity]
      ) {
        const most = MAX_NIGHTS[spec.granularity];

        context.addIssue({
          code: "custom",
          path: ["granularity"],
          message: `${spec.granularity} covers at most ${nightsText(most)}, and this range has ${count.toFixed(0)}. A range this long allows ${granularitiesFor(dataset, spec.nights).join(", ")}, or auto`,
        });
      }

      const labels = spec.calculations.map(calculationLabel);
      const repeated = (values: readonly string[], field: string): void => {
        values.forEach((value, index) => {
          if (values.indexOf(value) < index) {
            context.addIssue({
              code: "custom",
              path: [field, index],
              message: `${value} is already in ${field}`,
            });
          }
        });
      };

      repeated(labels, "calculations");
      repeated(spec.breakdowns, "breakdowns");
      repeated(
        spec.orders.map(({ op, column }) =>
          op === undefined ? (column ?? "") : calculationLabel({ op, column }),
        ),
        "orders",
      );

      spec.orders.forEach(({ op, column }, index) => {
        const named =
          op === undefined
            ? spec.breakdowns.some((breakdown) => breakdown === column)
            : labels.includes(calculationLabel({ op, column }));

        if (!named) {
          context.addIssue({
            code: "custom",
            path: ["orders", index],
            message: `an order names a calculation or a breakdown of this query: ${[...labels, ...spec.breakdowns].join(", ")}`,
          });
        }
      });

      spec.havings.forEach(({ calculate_op: op, column, value }, index) => {
        if (!labels.includes(calculationLabel({ op, column }))) {
          context.addIssue({
            code: "custom",
            path: ["havings", index],
            message: `a having names a calculation of this query: ${labels.join(", ")}`,
          });

          return;
        }

        const { schema, expected } = HAVING_VALUES[calculationKind(dataset, { op, column })];

        if (!schema.safeParse(value).success) {
          context.addIssue({
            code: "custom",
            path: ["havings", index, "value"],
            message: `${calculationLabel({ op, column })} compares with ${expected}`,
          });
        }
      });
    });
}

const [firstDataset, ...otherDatasets] = DATASETS;
/**
 * A builder query: what to compute over which rows of one dataset. It accepts only what the
 * registry describes, so a parsed spec names real columns with operations and values that fit them.
 */
export const querySpec = z.discriminatedUnion("dataset", [
  specSchema(firstDataset),
  ...otherDatasets.map(specSchema),
]);
/** A query as it's written: only `v`, `dataset`, and `nights` are required. */
export type QuerySpecInput = z.input<typeof querySpec>;
/** A parsed query, with every default filled in. */
export type QuerySpec = z.infer<typeof querySpec>;
export type Calculation = QuerySpec["calculations"][number];
export type Filter = QuerySpec["filters"][number];
export type Order = QuerySpec["orders"][number];
export type Having = QuerySpec["havings"][number];

/** Where a spec is wrong, such as `filters[0].op`, and what's allowed there. */
export type SpecIssue = { path: string; message: string };

const pathText = (path: readonly PropertyKey[]): string =>
  path
    .map((key) => (typeof key === "number" ? `[${key.toFixed(0)}]` : `.${String(key)}`))
    .join("")
    .replace(/^\./v, "");

/** Checks a spec from a link, the builder, or an agent, and fills in its defaults. */
export function parseSpec(input: unknown): Result<QuerySpec, SpecIssue[]> {
  const parsed = querySpec.safeParse(input);

  return parsed.success
    ? ok(parsed.data)
    : err(parsed.error.issues.map(({ path, message }) => ({ path: pathText(path), message })));
}
