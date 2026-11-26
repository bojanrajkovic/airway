/**
 * Returns the zone's UTC offset in `year` without daylight saving time, as `±HH:MM`. DST always
 * adds time, so in either hemisphere that offset is the smaller of the January and July offsets.
 */
export function winterOffset(zone: string, year: number): string {
  const firstOf = (month: number): Temporal.ZonedDateTime =>
    Temporal.ZonedDateTime.from({ timeZone: zone, year, month, day: 1, hour: 12 });
  const january = firstOf(1);
  const july = firstOf(7);

  return january.offsetNanoseconds <= july.offsetNanoseconds ? january.offset : july.offset;
}

/**
 * Converts a time on the CPAP's clock to an instant. The clock stays on the zone's winter offset
 * all year.
 */
export const toInstant = (time: Temporal.PlainDateTime, zone: string): Temporal.Instant =>
  time.toZonedDateTime(winterOffset(zone, time.year)).toInstant();

/** Converts an instant to the time that the CPAP's clock shows. */
export const toDeviceTime = (at: Temporal.Instant, zone: string): Temporal.PlainDateTime =>
  at.toZonedDateTimeISO(winterOffset(zone, at.toZonedDateTimeISO(zone).year)).toPlainDateTime();
