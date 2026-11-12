/**
 * The instant a wall clock in `zone` shows `time` on `date`, such as
 * `instantAt("America/New_York", "2030-03-10", "15:00")`. A time that a DST change skips or repeats
 * resolves the way Temporal's `compatible` option does: a skipped time moves forward by the gap,
 * and a repeated one takes the earlier instant.
 */
export const instantAt = (zone: string, date: string, time: string): Temporal.Instant =>
  Temporal.PlainDateTime.from(`${date}T${time}`).toZonedDateTime(zone).toInstant();
