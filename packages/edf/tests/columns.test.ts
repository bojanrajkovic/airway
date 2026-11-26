import { describe, expect, it } from "vitest";
import { nights } from "@airway/contract/registry/nights";
import { samples } from "@airway/contract/registry/samples";
import { PLD_SAMPLE_COLUMNS, STR_NIGHT_COLUMNS, STR_SETTINGS } from "../src/columns.ts";

const metricsOf = (columns: readonly { name: string; role: string }[]): Set<string> =>
  new Set(columns.filter((column) => column.role === "metric").map((column) => column.name));

describe("PLD_SAMPLE_COLUMNS", () => {
  it("fills every samples metric and no other column", () => {
    expect(new Set(PLD_SAMPLE_COLUMNS.map(([, column]) => column))).toEqual(
      metricsOf(samples.columns),
    );
  });
});

describe("STR_NIGHT_COLUMNS", () => {
  it.each(STR_NIGHT_COLUMNS)("%s fills a nights metric named %s", (_label, column) => {
    expect(metricsOf(nights.columns)).toContain(column);
  });
});

describe("STR_SETTINGS", () => {
  it("names a setting by its label unless the setting has its own name", () => {
    const names = new Map<string, string>(STR_SETTINGS);

    expect(names.get("S.AS.MinPress")).toBe("min_pressure");
    expect(names.get("S.Mask")).toBe("S.Mask");
    expect(names.size).toBe(22);
  });
});
