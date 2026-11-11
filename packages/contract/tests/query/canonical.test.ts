import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { spec, specInput } from "../../src/query/arbitrary.ts";
import { canonicalJson, canonicalize } from "../../src/query/canonical.ts";
import { parseSpec, type QuerySpec } from "../../src/query/spec.ts";

const parsed = (input: unknown): QuerySpec => parseSpec(input)._unsafeUnwrap();

/** The same value with every object's keys in the opposite order. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reversed);
  }

  return typeof value === "object" && value !== null
    ? Object.fromEntries(
        Object.entries(value)
          .toReversed()
          .map(([key, inner]) => [key, reversed(inner)]),
      )
    : value;
}

describe("canonicalize", () => {
  it("leaves out everything that's a default", () => {
    const written = {
      v: 1,
      dataset: "events",
      nights: { last: 7 },
      calculations: [{ op: "COUNT" }],
      filters: [],
      filter_combination: "AND",
      breakdowns: ["type"],
      orders: [{ column: "type", order: "descending" }],
      havings: [],
      limit: 100,
    };

    expect(canonicalize(parsed(written))).toEqual({
      v: 1,
      dataset: "events",
      nights: { last: 7 },
      breakdowns: ["type"],
      orders: [{ column: "type" }],
    });
  });

  it("leaves out OR when there are fewer than two filters to combine", () => {
    const one = { column: "session", op: ">", value: 1 };
    const written = { v: 1, dataset: "events", nights: { last: 7 }, filter_combination: "OR" };

    expect(canonicalize(parsed({ ...written, filters: [one] })).filter_combination).toBeUndefined();
    expect(
      canonicalize(parsed({ ...written, filters: [one, { column: "type", op: "exists" }] }))
        .filter_combination,
    ).toBe("OR");
  });

  it("writes keys in one order, however they were written", () => {
    const written = {
      granularity: "night",
      filters: [{ value: 3, op: ">", column: "session" }],
      calculations: [{ column: "duration", op: "P95" }],
      nights: { to: "2031-03-31", from: "2031-03-01" },
      dataset: "events",
      v: 1,
    };

    expect(canonicalJson(parsed(written))).toBe(
      '{"v":1,"dataset":"events","nights":{"from":"2031-03-01","to":"2031-03-31"},' +
        '"calculations":[{"op":"P95","column":"duration"}],' +
        '"filters":[{"column":"session","op":">","value":3}],"granularity":"night"}',
    );
  });

  it("sorts each list and drops its repeats", () => {
    const filters = [
      { column: "session", op: "in", value: [10, 9, 2, 10] },
      { column: "type", op: "not-in", value: ["hypopnea", "arousal", "hypopnea"] },
    ];

    expect(
      canonicalize(parsed({ v: 1, dataset: "events", nights: { last: 1 }, filters })).filters,
    ).toEqual([
      { column: "session", op: "in", value: [2, 9, 10] },
      { column: "type", op: "not-in", value: ["arousal", "hypopnea"] },
    ]);
  });

  it("writes every time in UTC, so one instant has one spelling", () => {
    const written = {
      v: 1,
      dataset: "events",
      nights: { last: 1 },
      calculations: [{ op: "MAX", column: "ts" }],
      filters: [{ column: "ts", op: ">=", value: "2031-03-02T02:00:00-04:00" }],
      havings: [{ calculate_op: "MAX", column: "ts", op: "<", value: "2031-03-02T12:30:00+05:30" }],
    };
    const canonical = canonicalize(parsed(written));

    expect(canonical.filters).toEqual([{ column: "ts", op: ">=", value: "2031-03-02T06:00:00Z" }]);
    expect(canonical.havings?.[0]?.value).toBe("2031-03-02T07:00:00Z");
  });

  it("keeps clauses in the order they were written", () => {
    const breakdowns = ["type", "hour_of_night", "night"];

    expect(
      canonicalize(parsed({ v: 1, dataset: "events", nights: { last: 1 }, breakdowns })).breakdowns,
    ).toEqual(breakdowns);
  });

  it("gives a spec that parses back to the same canonical form", () => {
    fc.assert(
      fc.property(spec, (generated) => {
        const canonical = canonicalize(generated);

        expect(canonicalize(parsed(canonical))).toEqual(canonical);
      }),
    );
  });

  it("gives the same JSON whatever order the keys were written in", () => {
    fc.assert(
      fc.property(specInput, (input) => {
        expect(canonicalJson(parsed(reversed(input)))).toBe(canonicalJson(parsed(input)));
      }),
    );
  });
});
