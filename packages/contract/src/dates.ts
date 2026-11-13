import { z } from "zod";

// tRPC's transformer rebuilds Temporal values on the server, so procedure inputs take them as is.
/** A `Temporal.PlainDate` value, as a procedure input receives one. */
export const PlainDate = z.instanceof(Temporal.PlainDate);
/** A `Temporal.Instant` value, as a procedure input receives one. */
export const Instant = z.instanceof(Temporal.Instant);

/** An ISO calendar date such as `2026-11-04`, parsed to a `Temporal.PlainDate`. */
export const PlainDateString = z.iso.date().transform((date) => Temporal.PlainDate.from(date));
