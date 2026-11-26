import type { RuleSet } from "../profile.ts";

/**
 * `app.status` returns the values that the app's header and the MCP instructions show.
 *
 * `app.status` returns the patient's age and leaves out their birth date. A name and a birth date
 * together identify a minor, and an agent sends everything that it reads to its model provider.
 * For clinical context, the age is as useful as the birth date.
 */
export type AppStatus = {
  displayName: string;
  /**
   * `age` is the patient's age today, as whole years plus the whole months since the last
   * birthday.
   */
  age: { years: number; months: number };
  /** `ruleSet` is the scoring rule set that applies today, pediatric or adult. */
  ruleSet: RuleSet;
  /** `deviceModel` is the CPAP's model, or null before the first import. */
  deviceModel: string | null;
  /** `nights` is the first and last imported night, or null before the first import. */
  nights: { first: Temporal.PlainDate; last: Temporal.PlainDate } | null;
  derivedVersion: number;
  /** `timeZone` is the home time zone, such as `America/New_York`. */
  timeZone: string;
};
