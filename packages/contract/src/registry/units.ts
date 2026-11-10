/**
 * A column's unit and how many decimals its values have. For a machine signal, ingest reads both
 * from the EDF header; a column airway computes declares its own.
 */
export type ColumnUnit = { unit: string; decimals: number };

type Conversion = { unit: string; factor: number };

// Stored units the app shows as something else. Any other unit is shown as stored.
const DISPLAY: Record<string, Conversion> = {
  "L/s": { unit: "L/min", factor: 60 },
  L: { unit: "mL", factor: 1000 },
};
// A header step such as 1/3 has no exact decimal form, so it gets this many.
const MAX_DECIMALS = 6;

const conversionFor = (unit: string): Conversion => DISPLAY[unit] ?? { unit, factor: 1 };

// Rounding removes the error a float multiply or divide leaves: 24 / 60 is 0.39999999999999997,
// then 0.4. The extra decimals keep a value between two steps, such as an average or a filter
// bound, where it is instead of moving it onto a step.
const GUARD_DECIMALS = 6;
const round = (value: number, decimals: number): number =>
  Math.round(value * 10 ** (decimals + GUARD_DECIMALS)) / 10 ** (decimals + GUARD_DECIMALS);

/** The decimals needed to write every multiple of `step`, an EDF signal's physical step. */
export function decimalsForStep(step: number): number {
  for (let decimals = 0; decimals < MAX_DECIMALS; decimals += 1) {
    const scaled = step * 10 ** decimals;

    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) {
      return decimals;
    }
  }

  return MAX_DECIMALS;
}

/** How the app shows a stored unit: L/s as L/min, L as mL, and anything else as itself. */
export function displayUnit(stored: ColumnUnit): ColumnUnit {
  const { unit, factor } = conversionFor(stored.unit);

  return { unit, decimals: decimalsForStep(factor / 10 ** stored.decimals) };
}

/** Converts a stored value to its display unit. */
export function toDisplay(value: number, stored: ColumnUnit): number {
  return round(value * conversionFor(stored.unit).factor, displayUnit(stored).decimals);
}

/** Converts a value in the display unit, such as a builder filter's, to the stored unit. */
export function toStored(value: number, stored: ColumnUnit): number {
  return round(value / conversionFor(stored.unit).factor, stored.decimals);
}
