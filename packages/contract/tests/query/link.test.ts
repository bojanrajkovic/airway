import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { spec } from "../../src/query/arbitrary.ts";
import { canonicalize } from "../../src/query/canonical.ts";
import { parseExploreQuery, toExploreUrl } from "../../src/query/link.ts";
import { parseSpec } from "../../src/query/spec.ts";

const events = { v: 1, dataset: "events", nights: { last: 7 } };
/** The decoded `q` of a link, as a router hands it over. */
const queryOf = (url: string): string =>
  new URL(url, "http://airway.test").searchParams.get("q") ?? "";

describe("toExploreUrl", () => {
  it("puts the canonical JSON in q", () => {
    const url = toExploreUrl(parseSpec({ ...events, limit: 100 })._unsafeUnwrap())._unsafeUnwrap();

    expect(url).toBe(
      `/explore?q=${encodeURIComponent('{"v":1,"dataset":"events","nights":{"last":7}}')}`,
    );
  });

  it("refuses a spec whose link would pass the limit", () => {
    const sessions = Array.from({ length: 50 }, (_, index) => 1_000_000 + index);
    const filters = Array.from({ length: 20 }, () => ({
      column: "session",
      op: "in",
      value: sessions,
    }));
    const long = parseSpec({ ...events, filters })._unsafeUnwrap();

    expect(toExploreUrl(long)._unsafeUnwrapErr()).toBe("too_long");
  });
});

describe("parseExploreQuery", () => {
  it("reads back the query a link was made from", () => {
    fc.assert(
      fc.property(spec, (generated) => {
        // A generated spec can be too long for a link, and those have nothing to read back.
        fc.pre(toExploreUrl(generated).isOk());

        const read = parseExploreQuery(queryOf(toExploreUrl(generated)._unsafeUnwrap()));

        expect(canonicalize(read._unsafeUnwrap())).toEqual(canonicalize(generated));
      }),
    );
  });

  it.for([
    { what: "text that isn't JSON", q: '{"v":1,', path: "", says: "JSON" },
    {
      what: "a version it doesn't know",
      q: JSON.stringify({ ...events, v: 2 }),
      path: "v",
      says: "expected 1",
    },
    {
      what: "a spec that breaks a rule",
      q: JSON.stringify({ ...events, breakdowns: ["duration"] }),
      path: "breakdowns[0]",
      says: "hour_of_night",
    },
  ])("keeps the raw text of $what, for the error view", ({ q, path, says }) => {
    const { raw, issues } = parseExploreQuery(q)._unsafeUnwrapErr();

    expect(raw).toBe(q);
    expect(issues[0]?.path).toBe(path);
    expect(issues[0]?.message).toContain(says);
  });
});
