import type { SignalValues } from "./rows.ts";

/** A day STR.edf covers when the machine wasn't used: every value but the date is missing. */
export type UnusedStrDay = { day: Temporal.PlainDate; used: false };

/** A day of STR.edf with the machine's statistics and settings. */
export type UsedStrDay = {
  day: Temporal.PlainDate;
  used: true;
  /** MaskOn and MaskOff: minutes since noon on the device clock, NaN for an unused slot. */
  maskOn: readonly number[];
  maskOff: readonly number[];
  /** MaskEvents: two per mask-on period, including periods past the 10 slots. */
  maskEvents: number;
  /** The `nights` columns STR.edf fills, such as usage and leak_p95, null where it wrote -1. */
  signals: SignalValues;
  /** Each S.* setting by its name, such as max_pressure, null where it wrote -1. */
  settings: Readonly<Record<string, number | null>>;
};

/** One record of STR.edf, the machine's daily summary. */
export type StrDay = UnusedStrDay | UsedStrDay;
