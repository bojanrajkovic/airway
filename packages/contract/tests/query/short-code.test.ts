import { describe, expect, it } from "vitest";
import { shortCode, type ShortLinkTarget } from "../../src/query/short-code.ts";
import { parseSpec } from "../../src/query/spec.ts";

const spec = (input: unknown): ShortLinkTarget => ({
  kind: "spec",
  spec: parseSpec(input)._unsafeUnwrap(),
});
const events = { v: 1, dataset: "events", nights: { last: 7 } };

describe("shortCode", () => {
  // A changed code would orphan every stored short link.
  it.for([
    { target: spec(events), code: "kx57qy5k9n" },
    {
      target: spec({
        v: 1,
        dataset: "samples",
        nights: { from: "2031-03-01", to: "2031-03-31" },
        calculations: [{ op: "P95", column: "leak" }],
        breakdowns: ["hour_of_night"],
        granularity: "night",
      }),
      code: "vzz6qp9xm1",
    },
    {
      target: spec({
        v: 1,
        dataset: "nights",
        nights: { last: 90 },
        calculations: [{ op: "AVG", column: "ahi" }],
        filters: [{ column: "usage", op: ">", value: 240 }],
        granularity: "week",
      }),
      code: "2hrnw64mrp",
    },
    {
      target: { kind: "sql", text: "select count(*) from nights" } satisfies ShortLinkTarget,
      code: "twzsvpdnh7",
    },
  ])("gives $code, the same code as ever", async ({ target, code }) => {
    await expect(shortCode(target)).resolves.toBe(code);
  });

  it("gives one code to the same query written two ways", async () => {
    const reordered = { nights: { last: 7 }, limit: 100, dataset: "events", v: 1 };

    await expect(shortCode(spec(reordered))).resolves.toBe(await shortCode(spec(events)));
  });

  it("gives a spec and the same text as SQL different codes", async () => {
    const text = '{"v":1,"dataset":"events","nights":{"last":7}}';

    await expect(shortCode({ kind: "sql", text })).resolves.not.toBe(await shortCode(spec(events)));
  });

  it("ignores white space around a SQL statement", async () => {
    await expect(shortCode({ kind: "sql", text: "\n  select 1\n" })).resolves.toBe(
      await shortCode({ kind: "sql", text: "select 1" }),
    );
  });
});
