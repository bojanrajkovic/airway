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
// These take a metric column and return a number.
const NUMERIC = ["SUM", "AVG", ...PERCENTILES] as const;
// These take a number, integer, timestamp, or date column and return a value of the same kind.
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
// We accept ISO timestamps with an offset, so a time never depends on the reader's time zone. A
// few forms the ISO format allows, such as ten decimal places, are rejected because
// Temporal.Instant can't parse them.
export const instant = z.iso
  .datetime({ offset: true, error: TIME })
  .refine((text) => readInstant(text).isOk(), { error: TIME });
const date = z.iso.date();

// When neither shape matches, zod reports only "Invalid input", so this message names both.
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

/**
 * The schema for a filter on one column. It has up to three shapes, picked by `op`:
 *
 * - a comparison (`=`, `>`, and so on) with one value
 * - a null check (`exists`, `does-not-exist`) with no value
 * - a list operation (`in`, `not-in`) with a list of values
 *
 * Each shape allows only the operations `operationsFor` gives the column, and its values have the
 * column's type. docs/query.md has a diagram of how this fits into the whole spec.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type -- zod infers this schema's type; writing it out would repeat the schema
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
    // Numbers, booleans, and times have no list operations, and zod rejects a shape with an empty
    // `op` list, so they don't get this shape.
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

/**
 * The schema for one calculation in a dataset. It has four shapes, picked by `op`, and each lists
 * the columns its operations take (`columnsFor`): COUNT takes none, COUNT_DISTINCT takes any,
 * SUM, AVG, and the percentiles take a metric, and MIN and MAX take a column with an order.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type -- zod infers this schema's type; writing it out would repeat the schema
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

/**
 * The most buckets one group can get at a step: every night counted as a full 24 hours, noon to
 * noon, though a real night has data only while the mask is on.
 */
export const bucketCount = (nights: Nights, step: Granularity): number =>
  (nightCount(nights) * STEP_SECONDS.night) / STEP_SECONDS[step];

/** The fields of a spec that decide how it's bucketed. */
type Bucketing = { nights: Nights; granularity?: Granularity | "auto" | undefined };

/**
 * The step a spec buckets by, or undefined for totals only. `auto` picks the finest step the
 * dataset and night range allow with `nights × 86,400 ÷ step seconds ≤ AUTO_BUCKETS`. The pick
 * depends only on the spec, so a link's step never changes under it.
 */
export function granularityOf(
  dataset: Dataset,
  { nights, granularity }: Bucketing,
): Granularity | undefined {
  if (granularity !== "auto") {
    return granularity;
  }

  // `month` over the longest range, 3,660 nights, is 122 buckets, so it fits unless AUTO_BUCKETS
  // drops below that.
  return (
    granularitiesFor(dataset, nights).find((step) => bucketCount(nights, step) <= AUTO_BUCKETS) ??
    "month"
  );
}

/**
 * Maps a list that has at least one item, keeping that in the type. zod's unions take a list typed
 * as non-empty, and a plain `map` returns one typed as possibly empty.
 */
function mapNonEmpty<Item, Mapped>(
  [first, ...rest]: readonly [Item, ...Item[]],
  map: (item: Item) => Mapped,
): [Mapped, ...Mapped[]] {
  return [map(first), ...rest.map((item) => map(item))];
}

/** The fields of one dataset's spec, each checked on its own. */
// oxlint-disable-next-line typescript/explicit-function-return-type -- zod infers this schema's type; writing it out would repeat the schema
function fieldsSchema(dataset: Dataset) {
  const columns = z.enum(namesOf(dataset.columns));

  return z.strictObject({
    v: z.literal(1),
    dataset: z.literal(dataset.name),
    nights,
    calculations: z
      .array(calculationSchema(dataset))
      .min(1)
      .max(LIMITS.calculations)
      .default([{ op: "COUNT" }]),
    filters: z
      .array(z.discriminatedUnion("column", mapNonEmpty(dataset.columns, filterSchema)))
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
  });
}

/** A spec whose fields each passed their own checks, before the checks across fields. */
type Fields = z.output<ReturnType<typeof fieldsSchema>>;
/** Something wrong with a spec, at a path such as `["orders", 1]`. */
type Problem = { path: (string | number)[]; message: string };

const nightsText = (count: number): string =>
  count === 1 ? "1 night" : `${count.toFixed(0)} nights`;

/** A named step over more nights than it covers (`MAX_NIGHTS`). */
function rangeProblems(dataset: Dataset, { nights, granularity }: Fields): Problem[] {
  const count = nightCount(nights);

  if (granularity === undefined || granularity === "auto" || count <= MAX_NIGHTS[granularity]) {
    return [];
  }

  const allowed = granularitiesFor(dataset, nights).join(", ");

  return [
    {
      path: ["granularity"],
      message: `${granularity} covers at most ${nightsText(MAX_NIGHTS[granularity])}, and this range has ${count.toFixed(0)}. A range this long allows ${allowed}, or auto`,
    },
  ];
}

/** Each value after the first that's the same as an earlier one. */
function repeats(values: readonly string[], field: string): Problem[] {
  return values.flatMap((value, index) =>
    values.indexOf(value) < index
      ? [{ path: [field, index], message: `${value} is already in ${field}` }]
      : [],
  );
}

/** A calculation, breakdown, or order written twice. */
function repeatProblems({ calculations, breakdowns, orders }: Fields): Problem[] {
  const ordered = orders.map(({ op, column }) =>
    op === undefined ? (column ?? "") : calculationLabel({ op, column }),
  );

  return [
    ...repeats(calculations.map(calculationLabel), "calculations"),
    ...repeats(breakdowns, "breakdowns"),
    ...repeats(ordered, "orders"),
  ];
}

/** An order that names neither a calculation nor a breakdown of the same spec. */
function orderProblems({ calculations, breakdowns, orders }: Fields): Problem[] {
  const labels = calculations.map(calculationLabel);
  const names = (op: CalculationOp | undefined, column: string | undefined): boolean =>
    op === undefined
      ? breakdowns.some((one) => one === column)
      : labels.includes(calculationLabel({ op, column }));

  return orders.flatMap(({ op, column }, index) =>
    names(op, column)
      ? []
      : [
          {
            path: ["orders", index],
            message: `an order names a calculation or a breakdown of this query: ${[...labels, ...breakdowns].join(", ")}`,
          },
        ],
  );
}

const HAVING_VALUES = {
  number: { schema: z.number(), expected: "a number" },
  integer: { schema: z.number(), expected: "a number" },
  timestamp: { schema: instant, expected: "a time with its offset" },
  date: { schema: date, expected: "a date" },
};

/**
 * A having that names no calculation of the same spec, or compares with the wrong kind of value:
 * a number for most calculations, and a time or date for MIN and MAX of one.
 */
function havingProblems(dataset: Dataset, { calculations, havings }: Fields): Problem[] {
  const labels = calculations.map(calculationLabel);

  return havings.flatMap(({ calculate_op: op, column, value }, index): Problem[] => {
    const label = calculationLabel({ op, column });

    if (!labels.includes(label)) {
      return [
        {
          path: ["havings", index],
          message: `a having names a calculation of this query: ${labels.join(", ")}`,
        },
      ];
    }

    const { schema, expected } = HAVING_VALUES[calculationKind(dataset, { op, column })];

    return schema.safeParse(value).success
      ? []
      : [{ path: ["havings", index, "value"], message: `${label} compares with ${expected}` }];
  });
}

/** One dataset's spec: its fields, then the checks that look across them. */
// oxlint-disable-next-line typescript/explicit-function-return-type -- zod infers this schema's type; writing it out would repeat the schema
function specSchema(dataset: Dataset) {
  return fieldsSchema(dataset).superRefine((fields, context) => {
    const problems = [
      ...rangeProblems(dataset, fields),
      ...repeatProblems(fields),
      ...orderProblems(fields),
      ...havingProblems(dataset, fields),
    ];

    for (const { path, message } of problems) {
      context.addIssue({ code: "custom", path, message });
    }
  });
}

/**
 * A builder query: what to compute over which rows of one dataset. It accepts only what the
 * registry describes, so a parsed spec names real columns with operations and values that fit them.
 */
export const querySpec = z.discriminatedUnion("dataset", mapNonEmpty(DATASETS, specSchema));
/** A query as it's written: only `v`, `dataset`, and `nights` are required. */
export type QuerySpecInput = z.input<typeof querySpec>;
/** A query after parsing, with every default filled in. */
export type QuerySpec = z.output<typeof querySpec>;
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
