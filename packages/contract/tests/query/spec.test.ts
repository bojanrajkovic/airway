import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { spec, specInput } from "../../src/query/arbitrary.ts";
import { parseSpec } from "../../src/query/spec.ts";

const events = { v: 1, dataset: "events", nights: { last: 7 } };

describe("parseSpec", () => {
  it("fills in every default", () => {
    expect(parseSpec(events)._unsafeUnwrap()).toEqual({
      ...events,
      calculations: [{ op: "COUNT" }],
      filters: [],
      filter_combination: "AND",
      breakdowns: [],
      orders: [],
      havings: [],
      limit: 100,
    });
  });

  it("accepts every clause, with orders and havings that name the query's own parts", () => {
    const written = {
      ...events,
      nights: { from: "2031-03-01", to: "2031-03-31" },
      calculations: [
        { op: "P95", column: "duration" },
        { op: "MAX", column: "ts" },
        { op: "COUNT_DISTINCT", column: "night" },
      ],
      filters: [
        { column: "type", op: "in", value: ["hypopnea", "arousal"] },
        { column: "ts", op: ">", value: "2031-03-02T02:00:00-04:00" },
        { column: "duration", op: "exists" },
        { column: "outside_mask_on", op: "=", value: false },
      ],
      filter_combination: "OR",
      breakdowns: ["hour_of_night", "type"],
      orders: [
        { op: "P95", column: "duration" },
        { column: "type", order: "ascending" },
      ],
      havings: [
        { calculate_op: "P95", column: "duration", op: ">", value: 12.5 },
        { calculate_op: "MAX", column: "ts", op: "<", value: "2031-03-20T00:00:00Z" },
      ],
      limit: 1000,
      granularity: "1h",
    };

    expect(parseSpec(written)._unsafeUnwrap()).toEqual({
      ...written,
      orders: [
        { op: "P95", column: "duration", order: "descending" },
        { column: "type", order: "ascending" },
      ],
    });
  });

  it.for([
    {
      mistake: "an eleventh calculation",
      input: {
        ...events,
        calculations: [
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
        ].map((op) => ({ op, column: "duration" })),
      },
      path: "calculations",
      says: "<=10",
    },
    {
      mistake: "a calculation written twice",
      input: { ...events, calculations: [{ op: "COUNT" }, { op: "COUNT" }] },
      path: "calculations[1]",
      says: "COUNT is already in calculations",
    },
    {
      mistake: "an op that doesn't exist",
      input: { ...events, calculations: [{ op: "MEDIAN", column: "duration" }] },
      path: "calculations[0].op",
      says: "'P50'",
    },
    {
      mistake: "an average of a dimension",
      input: { ...events, calculations: [{ op: "AVG", column: "session" }] },
      path: "calculations[0].column",
      says: "duration",
    },
    {
      mistake: "the largest value of an enum",
      input: { ...events, calculations: [{ op: "MAX", column: "type" }] },
      path: "calculations[0].column",
      says: '"ts"',
    },
    {
      mistake: "> on an enum",
      input: { ...events, filters: [{ column: "type", op: ">", value: "hypopnea" }] },
      path: "filters[0].op",
      says: "'not-in'",
    },
    {
      mistake: "a value the enum doesn't have",
      input: { ...events, filters: [{ column: "type", op: "=", value: "sneeze" }] },
      path: "filters[0].value",
      says: '"obstructive_apnea"',
    },
    {
      mistake: "a column the dataset doesn't have",
      input: { ...events, filters: [{ column: "leak", op: ">", value: 1 }] },
      path: "filters[0].column",
      says: "'hour_of_night'",
    },
    {
      mistake: "a list on a metric",
      input: { ...events, filters: [{ column: "duration", op: "in", value: [10] }] },
      path: "filters[0].op",
      says: "'>='",
    },
    {
      mistake: "a list of 51 values",
      input: {
        ...events,
        filters: [{ column: "session", op: "in", value: Array.from({ length: 51 }, (_, n) => n) }],
      },
      path: "filters[0].value",
      says: "<=50",
    },
    {
      mistake: "a value on a null check",
      input: { ...events, filters: [{ column: "duration", op: "exists", value: 1 }] },
      path: "filters[0]",
      says: '"value"',
    },
    {
      mistake: "a time with no offset",
      input: { ...events, filters: [{ column: "ts", op: ">", value: "2031-03-02T02:00:00" }] },
      path: "filters[0].value",
      says: "offset",
    },
    {
      mistake: "a time finer than a nanosecond",
      input: {
        ...events,
        filters: [{ column: "ts", op: ">", value: "2031-03-02T02:00:00.1234567891Z" }],
      },
      path: "filters[0].value",
      says: "offset",
    },
    {
      mistake: "a breakdown by a metric",
      input: { ...events, breakdowns: ["duration"] },
      path: "breakdowns[0]",
      says: '"hour_of_night"',
    },
    {
      mistake: "a fourth breakdown",
      input: { ...events, breakdowns: ["night", "session", "type", "source"] },
      path: "breakdowns",
      says: "<=3",
    },
    {
      mistake: "an order on a calculation the query doesn't have",
      input: { ...events, orders: [{ op: "P95", column: "duration" }] },
      path: "orders[0]",
      says: "COUNT",
    },
    {
      mistake: "an order on a column that isn't a breakdown",
      input: { ...events, breakdowns: ["type"], orders: [{ column: "session" }] },
      path: "orders[0]",
      says: "COUNT, type",
    },
    {
      mistake: "an order written twice, even in opposite directions",
      input: {
        ...events,
        breakdowns: ["type"],
        orders: [{ column: "type" }, { column: "type", order: "ascending" }],
      },
      path: "orders[1]",
      says: "type is already in orders",
    },
    {
      mistake: "nights as text",
      input: { ...events, nights: { last: "7" } },
      path: "nights",
      says: '{"last": 1 to 3660} or {"from", "to"}',
    },
    {
      mistake: "nights written both ways",
      input: { ...events, nights: { last: 7, from: "2031-03-01", to: "2031-03-02" } },
      path: "nights",
      says: '{"last": 1 to 3660} or {"from", "to"}',
    },
    {
      mistake: "a having on a calculation the query doesn't have",
      input: {
        ...events,
        havings: [{ calculate_op: "AVG", column: "duration", op: ">", value: 1 }],
      },
      path: "havings[0]",
      says: "COUNT",
    },
    {
      mistake: "a having that compares a count with text",
      input: { ...events, havings: [{ calculate_op: "COUNT", op: ">", value: "2031-03-02" }] },
      path: "havings[0].value",
      says: "COUNT compares with a number",
    },
    {
      mistake: "2s buckets on nights",
      input: { v: 1, dataset: "nights", nights: { last: 7 }, granularity: "2s" },
      path: "granularity",
      says: '"night"|"week"|"month"',
    },
    {
      mistake: "a limit over 1,000",
      input: { ...events, limit: 1001 },
      path: "limit",
      says: "<=1000",
    },
    {
      mistake: "a range that ends before it starts",
      input: { ...events, nights: { from: "2031-03-02", to: "2031-03-01" } },
      path: "nights.to",
      says: "before from",
    },
    { mistake: "version 2", input: { ...events, v: 2 }, path: "v", says: "expected 1" },
    {
      mistake: "a dataset that doesn't exist",
      input: { ...events, dataset: "naps" },
      path: "dataset",
      says: "'breaths'",
    },
    {
      mistake: "a misspelled clause",
      input: { ...events, filter: [] },
      path: "",
      says: '"filter"',
    },
  ])("rejects $mistake, naming where and what's allowed", ({ input, path, says }) => {
    const [issue] = parseSpec(input)._unsafeUnwrapErr();

    expect(issue?.path).toBe(path);
    expect(issue?.message).toContain(says);
  });

  it("accepts every spec the generator writes", () => {
    fc.assert(
      fc.property(specInput, (input) => {
        expect(parseSpec(input).isOk()).toBe(true);
      }),
    );
  });

  it("returns a parsed spec unchanged when it's parsed again", () => {
    fc.assert(
      fc.property(spec, (parsed) => {
        expect(parseSpec(parsed)._unsafeUnwrap()).toEqual(parsed);
      }),
    );
  });
});
