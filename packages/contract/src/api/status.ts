import type { RuleSet } from "../profile.ts";

/**
 * `app.status` returns the values that the app's header and the MCP instructions show.
 *
 * `app.status` returns the patient's age and leaves out their birth date. A name and a birth date
 * together identify a minor, and an agent sends everything that it reads to its model provider.
 * For clinical context, the age is as useful as the birth date.
 */
export type AppStatus = {
  /** The patient's display name. */
  displayName: string;
  /** The patient's age today, as whole years plus the whole months since the last birthday. */
  age: { years: number; months: number };
  /** Whether the pediatric or the adult scoring rules apply today. */
  ruleSet: RuleSet;
  /** The CPAP's model, or null before the first import. */
  deviceModel: string | null;
  /** The first and last imported nights, or null before the first import. */
  nights: { first: Temporal.PlainDate; last: Temporal.PlainDate } | null;
  derivedVersion: number;
  /** The home time zone, such as `America/New_York`. */
  timeZone: string;
};
