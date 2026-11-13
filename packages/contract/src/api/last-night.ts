/**
 * Whether last night's data is here.
 *
 * - `arrived`: its folder was imported
 * - `unused`: STR.edf says the machine wasn't used, so no folder is coming
 * - `pending`: it was used, and there's still time for the upload before the cutoff
 * - `missing`: it was used, and the cutoff passed without its folder
 */
export type LastNightStatus = "arrived" | "pending" | "missing" | "unused";

/**
 * The home time by which a used night's folder should have arrived. Uploads finish by about 13:30
 * at the latest, so 15:00 leaves room.
 */
export const DATA_MISSING_CUTOFF = Temporal.PlainTime.from("15:00");

/** STR.edf's record of a day: minutes of use. */
export type StrDay = { usage: number };

/**
 * The night that ended this morning: today's date in the home time zone, minus one day. Nights
 * run noon to noon and are named for the date they start on.
 */
export function lastNightKey(now: Temporal.Instant, zone: string): Temporal.PlainDate {
  return now.toZonedDateTimeISO(zone).toPlainDate().subtract({ days: 1 });
}

/**
 * Last night's status at `now`. `strDay` is STR.edf's record of last night, and `folderImported`
 * says whether its DATALOG folder was imported.
 *
 * A night with no STR.edf record counts as used. STR.edf arrives with each upload, so a missed
 * upload also leaves it without last night's record, and that night should show as missing, not
 * unused. The ingest gauge, the Last night card, and `summary.lastNight` all call this, so the
 * 15:00 cutoff is defined only here.
 */
export function dataMissing(
  strDay: StrDay | undefined,
  folderImported: boolean,
  now: Temporal.Instant,
  zone: string,
): LastNightStatus {
  if (folderImported) {
    return "arrived";
  }

  if (strDay?.usage === 0) {
    return "unused";
  }

  const cutoff = lastNightKey(now, zone)
    .add({ days: 1 })
    .toZonedDateTime({ timeZone: zone, plainTime: DATA_MISSING_CUTOFF })
    .toInstant();

  return Temporal.Instant.compare(now, cutoff) < 0 ? "pending" : "missing";
}
