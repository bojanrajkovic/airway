import { describe, expect, it } from "vitest";
import { DATASETS } from "../../src/registry/datasets.ts";

describe.each(DATASETS)("the $name dataset", ({ columns }) => {
  const names = columns.map(({ name }) => name);

  it("names each column once", () => {
    expect(names).toEqual([...new Set(names)]);
  });

  it("names columns the way Postgres folds them, so SQL needs no quotes", () => {
    expect(names.filter((name) => !/^[a-z][a-z0-9_]*$/v.test(name))).toEqual([]);
  });
});
