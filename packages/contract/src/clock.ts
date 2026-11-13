import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { PlainDateString } from "./dates.ts";

/**
 * The CPAP's clock doesn't follow daylight saving time and drifts, so its timestamps convert to
 * UTC with a fixed offset. Each entry applies from the night `from` until the next entry's night.
 * `utcOffset` is `±HH:MM`, the precision Temporal accepts for an offset time zone.
 */
export const ClockOffset = z.strictObject({
  from: PlainDateString,
  utcOffset: z.string().regex(/^[+\-](?:[01]\d|2[0-3]):[0-5]\d$/v, "must be ±HH:MM"),
});
export type ClockOffset = z.infer<typeof ClockOffset>;

const ascending = (offsets: ClockOffset[]): boolean =>
  offsets.every((offset, i) => {
    const previous = offsets[i - 1];

    return previous === undefined || Temporal.PlainDate.compare(previous.from, offset.from) < 0;
  });

/** The device's clock offsets, oldest first, with at most one entry per night. */
export const ClockOffsets = z
  .array(ClockOffset)
  .min(1)
  .refine(ascending, "must be sorted by `from`, with no night listed twice");

export type BeforeFirstOffset = { kind: "before_first_offset"; night: Temporal.PlainDate };

/** The offset a night uses: the latest entry whose `from` is on or before the night. */
export function offsetForNight(
  offsets: readonly ClockOffset[],
  night: Temporal.PlainDate,
): Result<ClockOffset, BeforeFirstOffset> {
  const offset = offsets.findLast((entry) => Temporal.PlainDate.compare(entry.from, night) <= 0);

  return offset === undefined ? err({ kind: "before_first_offset", night }) : ok(offset);
}
