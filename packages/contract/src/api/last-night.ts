import type { DailyUsageRow } from "../derived/rows.ts";

/**
 * Says whether last night's data has arrived.
 *
 * - `arrived`: airway imported last night's DATALOG folder
 * - `unused`: STR.edf records zero usage for last night, so no DATALOG folder will arrive
 * - `pending`: the machine was used, and the DATALOG folder can still arrive before the cutoff
 * - `missing`: the machine was used, and the DATALOG folder didn't arrive by the cutoff
 */
export type LastNightStatus = "arrived" | "pending" | "missing" | "unused";

/**
 * `zone` is the home time zone. `cutoff` is the time of day in `zone` after which a used night
 * without a DATALOG folder is `missing`.
 */
export type DataMissingHome = { zone: string; cutoff: Temporal.PlainTime };

/**
 * Returns the night that ended this morning, which is yesterday's date in the home time zone.
 * Nights run noon to noon and are named for the date they start on.
 */
export function lastNightKey(now: Temporal.Instant, zone: string): Temporal.PlainDate {
  return now.toZonedDateTimeISO(zone).toPlainDate().subtract({ days: 1 });
}

/**
 * Returns last night's status at `now`. `strDay` is last night's `daily_usage` row, from STR.edf,
 * and `folderImported` says whether last night's DATALOG folder was imported.
 *
 * An undefined `strDay` counts as used, because STR.edf contains last night's record only after
 * last night's DATALOG folder arrives. Until then, the night is `pending` or `missing`.
 */
export function dataMissing(
  strDay: Pick<DailyUsageRow, "usage"> | undefined,
  folderImported: boolean,
  now: Temporal.Instant,
  { zone, cutoff }: DataMissingHome,
): LastNightStatus {
  if (folderImported) {
    return "arrived";
  }

  if (strDay?.usage === 0) {
    return "unused";
  }

  const deadline = lastNightKey(now, zone)
    .add({ days: 1 })
    .toZonedDateTime({ timeZone: zone, plainTime: cutoff })
    .toInstant();

  return Temporal.Instant.compare(now, deadline) < 0 ? "pending" : "missing";
}
