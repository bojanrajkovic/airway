import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decimalsForStep,
  displayUnit,
  toDisplay,
  toStored,
  type ColumnUnit,
} from "../../src/registry/units.ts";

const litresPerSecond: ColumnUnit = { unit: "L/s", decimals: 2 };
const litres: ColumnUnit = { unit: "L", decimals: 2 };
const pressure: ColumnUnit = { unit: "cmH2O", decimals: 2 };

describe("decimalsForStep", () => {
  it.each([
    [1, 0],
    [0.2, 1],
    [0.02, 2],
    [0.125, 3],
    [0.002, 3],
    [30 / 240, 3],
    [1 / 3, 6],
  ])("a step of %d needs %d decimals", (step, decimals) => {
    expect(decimalsForStep(step)).toBe(decimals);
  });
});

describe("displayUnit", () => {
  it.each([
    [litresPerSecond, { unit: "L/min", decimals: 1 }],
    [litres, { unit: "mL", decimals: 0 }],
    [
      { unit: "L", decimals: 4 },
      { unit: "mL", decimals: 1 },
    ],
    [pressure, pressure],
    [
      { unit: "furlongs", decimals: 3 },
      { unit: "furlongs", decimals: 3 },
    ],
  ])("shows %o as %o", (stored, display) => {
    expect(displayUnit(stored)).toEqual(display);
  });
});

describe("toDisplay and toStored", () => {
  it.each([
    [0.4, litresPerSecond, 24],
    // 1.14 * 60 is 68.39999999999999, and 68.4 / 60 is 1.1400000000000001.
    [1.14, litresPerSecond, 68.4],
    [0.3, litres, 300],
    [12.34, pressure, 12.34],
  ])("converts %d stored to %d shown, and back", (stored, unit, shown) => {
    expect(toDisplay(stored, unit)).toBe(shown);
    expect(toStored(shown, unit)).toBe(stored);
  });

  it("keeps a value between two device steps where it is", () => {
    // 25 L/min falls between 0.40 and 0.42 L/s. Snapped to 0.42, `leak > 25` would lose 0.42.
    expect(toStored(25, litresPerSecond)).toBe(0.41666667);
    // An average isn't on the grid either.
    expect(toDisplay(0.355, litresPerSecond)).toBe(21.3);
    expect(toDisplay(2.4, { unit: "sessions", decimals: 0 })).toBe(2.4);
  });

  it("returns every value on the stored grid unchanged after a round trip", () => {
    const onGrid = fc
      .record({
        unit: fc.constantFrom("L/s", "L", "cmH2O"),
        decimals: fc.integer({ min: 0, max: 6 }),
        steps: fc.integer({ min: -1_000_000, max: 1_000_000 }),
      })
      .map(({ unit, decimals, steps }) => ({
        stored: { unit, decimals },
        value: steps / 10 ** decimals,
      }));

    fc.assert(
      fc.property(onGrid, ({ stored, value }) => {
        expect(toStored(toDisplay(value, stored), stored)).toBe(value);
      }),
    );
  });
});
