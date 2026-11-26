import type { SignalValues } from "./rows.ts";

/** A day the machine wasn't used. The machine writes -1 for every STR.edf value except Date. */
export type UnusedStrDay = { day: Temporal.PlainDate; used: false };

/** A day the machine was used, with its statistics, settings, and mask-on periods. */
export type UsedStrDay = {
  day: Temporal.PlainDate;
  used: true;
  /** Minutes since noon on the machine's clock, one per slot. An unused slot is NaN. */
  maskOn: readonly number[];
  maskOff: readonly number[];
  /** Counts mask-on and mask-off events, two per period, including periods beyond the 10 slots. */
  maskEvents: number;
  /**
   * Values for the `nights` columns, such as usage and leak_p95. A value is null where STR.edf has
   * -1.
   */
  signals: SignalValues;
  /** Each S.* setting by name, such as max_pressure. A setting is null where STR.edf has -1. */
  settings: Readonly<Record<string, number | null>>;
};

/** One day of STR.edf, the machine's daily summary. */
export type StrDay = UnusedStrDay | UsedStrDay;
