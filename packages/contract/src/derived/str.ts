import type { SignalValues } from "./rows.ts";

/** A day the machine wasn't used. STR.edf writes -1 for every value except Date. */
export type UnusedStrDay = { day: Temporal.PlainDate; used: false };

/** A day the machine was used, with its statistics, settings, and mask-on periods. */
export type UsedStrDay = {
  day: Temporal.PlainDate;
  used: true;
  /** Minutes since noon on the device clock, one per slot. An unused slot is NaN. */
  maskOn: readonly number[];
  maskOff: readonly number[];
  /** Mask-on and mask-off events, two per period, including periods past the 10 slots. */
  maskEvents: number;
  /** Values for the `nights` columns, such as usage and leak_p95. Null where STR.edf has -1. */
  signals: SignalValues;
  /** Each S.* setting by name, such as max_pressure. Null where STR.edf has -1. */
  settings: Readonly<Record<string, number | null>>;
};

/** One day of STR.edf, the machine's daily summary. */
export type StrDay = UnusedStrDay | UsedStrDay;
