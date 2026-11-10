import { describe, expect, it } from "vitest";
import {
  dimension,
  enumeration,
  homeZone,
  metric,
  operationsFor,
  render,
  signal,
  sql,
  time,
} from "../../src/registry/define.ts";

describe("sql", () => {
  it("renders the home zone as the parameter it's given", () => {
    const hour = sql`extract(hour from ts at time zone ${homeZone})`;

    expect(render(hour, { homeZone: 3 })).toBe("extract(hour from ts at time zone $3)");
  });

  it("splices another fragment in, keeping its markers", () => {
    const local = sql`ts at time zone ${homeZone}`;
    const hour = sql`extract(hour from ${local})::int`;

    expect(render(hour, { homeZone: 1 })).toBe("extract(hour from ts at time zone $1)::int");
  });
});

describe("a column's SQL", () => {
  it("defaults to its name as a quoted identifier", () => {
    expect(render(signal("leak", "Leak.").sql, { homeZone: 1 })).toBe('"leak"');
  });

  it("quotes a name that isn't a plain identifier, so it can only ever name a column", () => {
    const column = metric('x"; drop table nights; --', { unit: "s", decimals: 1 }, "Hostile.");

    expect(render(column.sql, { homeZone: 1 })).toBe('"x""; drop table nights; --"');
  });

  it("is the given SQL when a column has its own", () => {
    const hour = dimension("hour_of_night", "integer", "Hour.", sql`extract(hour from ts)`);

    expect(render(hour.sql, { homeZone: 1 })).toBe("extract(hour from ts)");
  });
});

describe("operationsFor", () => {
  it.each([
    ["a metric", signal("leak", "Leak."), ["=", "!=", ">", ">=", "<", "<="]],
    ["a timestamp", time("ts", "timestamp", "When."), ["=", "!=", ">", ">=", "<", "<="]],
    [
      "an integer",
      dimension("session", "integer", "Session."),
      ["=", "!=", ">", ">=", "<", "<=", "in", "not-in"],
    ],
    ["a boolean", dimension("approximate", "boolean", "Flag."), ["=", "!="]],
    ["an enum", enumeration("type", ["hypopnea", "arousal"], "Type."), ["=", "!=", "in", "not-in"]],
  ])("allows %s its comparisons, plus the null checks", (_, column, comparisons) => {
    expect(operationsFor(column)).toEqual([...comparisons, "exists", "does-not-exist"]);
  });
});
