import type { ColumnUnit } from "./units.ts";

/** Stands for the home time zone in a column's SQL. `render` turns it into a bound parameter. */
export const homeZone: unique symbol = Symbol("homeZone");
type SqlPart = string | typeof homeZone;

declare const trusted: unique symbol;
/**
 * SQL that came from source code: text typed in a `sql` template. It never holds a value from a
 * request, so it's safe to put in a statement.
 */
export type TrustedSql = { readonly parts: readonly SqlPart[]; readonly [trusted]: true };

function trust(parts: readonly SqlPart[]): TrustedSql {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the one place a TrustedSql is made, from a template's source text
  return { parts } as TrustedSql;
}

/**
 * Tags SQL written in a registry file. Only another `TrustedSql` or `homeZone` can be
 * interpolated, so a string from anywhere else fails to compile.
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

/** The parameter number each marker is bound as, such as 3 for `$3`. */
export type RenderParameters = { homeZone: number };

/** The SQL text, with each marker replaced by its parameter. */
export function render(trustedSql: TrustedSql, parameters: RenderParameters): string {
  return trustedSql.parts
    .map((part) => (typeof part === "string" ? part : `$${parameters.homeZone.toFixed(0)}`))
    .join("");
}

type Described = {
  name: string;
  /** What the column means, for a person or an agent choosing columns. */
  description: string;
  /** Set only on a computed column. Without it, the column is the table column of the same name. */
  sql?: TrustedSql;
};

// A property can't be set to undefined, so a column without SQL leaves it out.
const computed = (sql: TrustedSql | undefined): Pick<Described, "sql"> =>
  sql === undefined ? {} : { sql };
export type TimeColumn = Described & { role: "time"; kind: "timestamp" | "date" };
export type DimensionColumn = Described &
  (
    | { role: "dimension"; kind: "integer" | "boolean" }
    | { role: "dimension"; kind: "enum"; values: readonly [string, ...string[]] }
  );
export type MetricColumn = Described & {
  role: "metric";
  kind: "number";
  /** `from_header` when the unit isn't fixed in code: it's recorded when the files are imported. */
  unit: ColumnUnit | "from_header";
};
/** One queryable column. Time and dimension columns can be grouped by; metrics can't. */
export type Column = TimeColumn | DimensionColumn | MetricColumn;

export type Dataset = {
  /** Also the name of the derived table its columns read. */
  name: string;
  description: string;
  columns: readonly Column[];
};

/** A value the machine recorded. */
export function signal(name: string, description: string): MetricColumn {
  return {
    name,
    description,
    role: "metric",
    kind: "number",
    unit: "from_header",
  };
}

/** A value airway computes, in a unit airway chooses. */
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
const ORDER = [...EQUALITY, ">", ">=", "<", "<="] as const;
const MEMBERSHIP = ["in", "not-in"] as const;
const NULL_CHECKS = ["exists", "does-not-exist"] as const;
export type FilterOperation =
  | (typeof ORDER)[number]
  | (typeof MEMBERSHIP)[number]
  | (typeof NULL_CHECKS)[number];

/** The filter operations a column allows, which follow from its kind. */
export function operationsFor(column: Column): readonly FilterOperation[] {
  switch (column.kind) {
    case "number":
    case "timestamp":
    case "date": {
      return [...ORDER, ...NULL_CHECKS];
    }

    case "integer": {
      return [...ORDER, ...MEMBERSHIP, ...NULL_CHECKS];
    }

    case "enum": {
      return [...EQUALITY, ...MEMBERSHIP, ...NULL_CHECKS];
    }

    case "boolean": {
      return [...EQUALITY, ...NULL_CHECKS];
    }
  }
}
