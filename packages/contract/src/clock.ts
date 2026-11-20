/**
 * The zone's UTC offset in `year` without daylight saving time, as `±HH:MM`. Because DST always
 * adds time, it's the smaller of the January and July offsets, in either hemisphere.
 */
export function winterOffset(zone: string, year: number): string {
  const firstOf = (month: number): Temporal.ZonedDateTime =>
    Temporal.ZonedDateTime.from({ timeZone: zone, year, month, day: 1, hour: 12 });
  const january = firstOf(1);
  const july = firstOf(7);

  return january.offsetNanoseconds <= july.offsetNanoseconds ? january.offset : july.offset;
}

/** A device-clock time as an instant. The CPAP's clock keeps the zone's winter offset all year. */
export const toInstant = (time: Temporal.PlainDateTime, zone: string): Temporal.Instant =>
  time.toZonedDateTime(winterOffset(zone, time.year)).toInstant();

/** An instant as the CPAP's clock shows it. */
export const toDeviceTime = (at: Temporal.Instant, zone: string): Temporal.PlainDateTime =>
  at.toZonedDateTimeISO(winterOffset(zone, at.toZonedDateTimeISO(zone).year)).toPlainDateTime();
