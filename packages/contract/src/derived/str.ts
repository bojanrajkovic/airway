import type { SignalValues } from "./rows.ts";

/**
 * Describes a day when the machine wasn't used. The machine writes -1 for every STR.edf value
 * except Date.
 */
export type UnusedStrDay = { day: Temporal.PlainDate; used: false };

/**
 * Describes a day when the machine was used, with its statistics, settings, and mask-on
 * periods.
 */
export type UsedStrDay = {
  day: Temporal.PlainDate;
  used: true;
  /**
   * `maskOn` contains one time per slot, in minutes since noon on the machine's clock. An unused
   * slot is NaN.
   */
  maskOn: readonly number[];
  maskOff: readonly number[];
  /** Counts mask-on and mask-off events, two per period, including periods beyond the 10 slots. */
  maskEvents: number;
  /**
   * Maps each `nights` column, such as usage and leak_p95, to its value. A value is null where
   * STR.edf has -1.
   */
  signals: SignalValues;
  /**
   * Maps each S.* setting's name, such as max_pressure, to its value. A setting is null where
   * STR.edf has -1.
   */
  settings: Readonly<Record<string, number | null>>;
};

/** Describes one day of STR.edf, the machine's daily summary. */
export type StrDay = UnusedStrDay | UsedStrDay;
