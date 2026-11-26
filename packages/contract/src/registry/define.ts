import type { ColumnUnit } from "./units.ts";

/** Stands for the home time zone in a column's SQL. `render` turns it into a bound parameter. */
export const homeZone: unique symbol = Symbol("homeZone");
type SqlPart = string | typeof homeZone;

declare const trusted: unique symbol;
/**
 * Marks SQL that a developer typed in a `sql` template. Every part comes from source code, so the
 * SQL is safe to put in a statement.
 */
export type TrustedSql = { readonly parts: readonly SqlPart[]; readonly [trusted]: true };

function trust(parts: readonly SqlPart[]): TrustedSql {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the one place a TrustedSql is made, from a template's source text
  return { parts } as TrustedSql;
}

/**
 * Tags SQL written in a registry file. Interpolated values must be `TrustedSql` or `homeZone`, so
 * interpolating any other string fails to compile.
 */
export function sql(
  strings: TemplateStringsArray,
  ...values: readonly (TrustedSql | typeof homeZone)[]
): TrustedSql {
  const parts = strings.flatMap((text, index): SqlPart[] => {
    const value = values[index];

    if (value === undefined) {
      return [text];
    }

    return typeof value === "symbol" ? [text, value] : [text, ...value.parts];
  });

  return trust(parts);
}

/** Maps each marker to the number of its bound parameter, such as 3 for `$3`. */
export type RenderParameters = { homeZone: number };

/** Returns the SQL text with each marker replaced by its parameter. */
export function render(trustedSql: TrustedSql, parameters: RenderParameters): string {
  return trustedSql.parts
    .map((part) => (typeof part === "string" ? part : `$${parameters.homeZone.toFixed(0)}`))
    .join("");
}

type Described = {
  name: string;
  /** Tells a person or an agent choosing columns what the column means. */
  description: string;
  /** A computed column sets `sql`. Every other column reads the table column of the same name. */
  sql?: TrustedSql;
};

// An optional property can't be set to undefined, so a column without SQL omits `sql`.
const computed = (sql: TrustedSql | undefined): Pick<Described, "sql"> =>
  sql === undefined ? {} : { sql };
export type TimeColumn = Described & { role: "time"; kind: "timestamp" | "date" };
export type DimensionColumn = Described &
  (
    | { role: "dimension"; kind: "integer" | "boolean" }
    | { role: "dimension"; kind: "enum"; values: readonly [string, ...string[]] }
  );
/**
 * Each value is a way to combine a nights metric's nightly values into one value for a week or
 * month.
 * docs/trends.md describes each one.
 */
export const COMBINE = ["rate", "median", "max", "mean"] as const;
export type Combine = (typeof COMBINE)[number];

export type MetricColumn = Described & {
  role: "metric";
  kind: "number";
  /** `from_header` means the unit comes from the signal's EDF header, through `COLUMN_UNITS`. */
  unit: ColumnUnit | "from_header";
};

/**
 * Adds `combine` to a metric of the `nights` dataset. Only nights are combined into weeks and
 * months, so only a nights metric sets `combine`.
 */
export type NightsMetric = MetricColumn & { combine: Combine };
export type Column = TimeColumn | DimensionColumn | MetricColumn;

export type Dataset = {
  /** Identifies the dataset and its table in the derived schema. */
  name: string;
  description: string;
  /**
   * `grain` is the shortest time step that a query can bucket the dataset's rows into. A `nights`
   * row covers a whole night, so its grain is `night`.
   */
  grain: "2s" | "night";
  columns: readonly [Column, ...Column[]];
};

/**
 * Builds a metric column for a value that the machine recorded. Its unit comes from `@airway/edf`'s
 * `COLUMN_UNITS`.
 */
export function signal(name: string, description: string): MetricColumn {
  return {
    name,
    description,
    role: "metric",
    kind: "number",
    unit: "from_header",
  };
}

/** Builds a metric column for a value that airway computes, in a unit that airway chooses. */
export function metric(
  name: string,
  unit: ColumnUnit,
  description: string,
  columnSql?: TrustedSql,
): MetricColumn {
  return { name, description, ...computed(columnSql), role: "metric", kind: "number", unit };
}

export function dimension(
  name: string,
  kind: "integer" | "boolean",
  description: string,
  columnSql?: TrustedSql,
): DimensionColumn {
  return { name, description, ...computed(columnSql), role: "dimension", kind };
}

export function enumeration(
  name: string,
  values: readonly [string, ...string[]],
  description: string,
): DimensionColumn {
  return { name, description, role: "dimension", kind: "enum", values };
}

export function time(name: string, kind: TimeColumn["kind"], description: string): TimeColumn {
  return { name, description, role: "time", kind };
}

const EQUALITY = ["=", "!="] as const;
/** These operations compare a column with one value. */
export const COMPARISONS = [...EQUALITY, ">", ">=", "<", "<="] as const;
/** These operations compare a column with a list of values. */
export const MEMBERSHIP = ["in", "not-in"] as const;
/** These operations check whether a column has a value. */
export const NULL_CHECKS = ["exists", "does-not-exist"] as const;
export type Comparison = (typeof COMPARISONS)[number];
export type FilterOperation =
  | Comparison
  | (typeof MEMBERSHIP)[number]
  | (typeof NULL_CHECKS)[number];

/** Returns the filter operations that a query can apply to `column`. */
export function operationsFor(column: Column): readonly FilterOperation[] {
  switch (column.kind) {
    case "number":
    case "timestamp":
    case "date": {
      return [...COMPARISONS, ...NULL_CHECKS];
    }

    case "integer": {
      return [...COMPARISONS, ...MEMBERSHIP, ...NULL_CHECKS];
    }

    case "enum": {
      return [...EQUALITY, ...MEMBERSHIP, ...NULL_CHECKS];
    }

    case "boolean": {
      return [...EQUALITY, ...NULL_CHECKS];
    }
  }
}
