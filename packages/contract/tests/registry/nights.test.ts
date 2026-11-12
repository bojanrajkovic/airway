import { expect, test } from "vitest";
import { nights } from "../../src/registry/nights.ts";

// The column type already requires `combine`. These cases check that each kind of column gets the
// right value.
test.for([
  ["ahi", "rate"],
  ["rin", "rate"],
  ["leak_p95", "median"],
  ["mask_pressure_p50", "median"],
  ["leak_max", "max"],
  ["usage", "mean"],
  ["obstructive_apneas", "mean"],
] as const)("over a week or month, %s combines by %s", ([name, combine]) => {
  const column = nights.columns.find((candidate) => candidate.name === name);

  expect(column?.role === "metric" ? column.combine : undefined).toBe(combine);
});
