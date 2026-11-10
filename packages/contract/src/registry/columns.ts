import { dimension, homeZone, sql, time, type Column } from "./define.ts";
import type { ColumnUnit } from "./units.ts";

// Columns and units that more than one dataset uses.

export const night = time(
  "night",
  "date",
  "The sleep day, noon to noon, named for the date it starts on.",
);
export const session = dimension(
  "session",
  "integer",
  "The mask-on period's number within its night, starting at 1.",
);
export const segment = dimension(
  "segment",
  "integer",
  "The recording file's number within its night, starting at 1.",
);
export const hourOfNight = dimension(
  "hour_of_night",
  "integer",
  "The wall-clock hour in the home time zone, 0 to 23.",
  sql`extract(hour from ts at time zone ${homeZone})::int`,
);

/** `ts` with the dataset's own description of what the moment is. */
export const ts = (description: string): Column => time("ts", "timestamp", description);

export const minutes: ColumnUnit = { unit: "min", decimals: 1 };
export const seconds: ColumnUnit = { unit: "s", decimals: 1 };
export const count = (unit: string): ColumnUnit => ({ unit, decimals: 0 });
