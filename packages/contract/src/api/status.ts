import type { RuleSet } from "../profile.ts";

/**
 * What `app.status` returns: what the app's header and the MCP instructions show.
 *
 * It gives the patient's age, not their birth date. A birth date and a name together identify a
 * minor, and everything an agent sees goes to its model provider. The age gives the same clinical
 * context.
 */
export type AppStatus = {
  /** The patient's display name. */
  displayName: string;
  /** The patient's age today, in whole years and the months past them. */
  age: { years: number; months: number };
  /** The scoring rules in effect today: pediatric or adult. */
  ruleSet: RuleSet;
  /** The CPAP's model, or null before the first import. */
  deviceModel: string | null;
  /** The first and last imported nights, or null before the first import. */
  nights: { first: Temporal.PlainDate; last: Temporal.PlainDate } | null;
  derivedVersion: number;
  /** The home time zone, such as `America/New_York`. */
  timeZone: string;
};
