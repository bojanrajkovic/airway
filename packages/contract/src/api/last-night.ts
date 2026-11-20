import type { DailyUsageRow } from "../derived/rows.ts";

/**
 * Whether last night's data is here.
 *
 * - `arrived`: its folder was imported
 * - `unused`: STR.edf says the machine wasn't used, so no folder is coming
 * - `pending`: it was used, and its folder can still arrive before the cutoff
 * - `missing`: it was used, and the cutoff passed without its folder
 */
export type LastNightStatus = "arrived" | "pending" | "missing" | "unused";

/** The home time zone, and the home time by which a used night's folder should have arrived. */
export type DataMissingHome = { zone: string; cutoff: Temporal.PlainTime };

/**
 * The night that ended this morning: today's date in the home time zone, minus one day. Nights
 * run noon to noon and are named for the date they start on.
 */
export function lastNightKey(now: Temporal.Instant, zone: string): Temporal.PlainDate {
  return now.toZonedDateTimeISO(zone).toPlainDate().subtract({ days: 1 });
}

/**
 * Last night's status at `now`. `strDay` is last night's `daily_usage` row, from STR.edf, and
 * `folderImported` says whether its DATALOG folder was imported.
 *
 * A night with no STR.edf record counts as used. STR.edf arrives with the night's files, so when
 * they don't arrive it has no record for last night either, and that night should show as
 * missing, not unused. The ingest gauge, the Last night card, and `summary.lastNight` all call
 * this, so the cutoff rule lives only here.
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
