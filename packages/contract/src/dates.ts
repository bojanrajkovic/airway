import { z } from "zod";

// tRPC's transformer rebuilds Temporal values on the server, so these schemas check them with
// `instanceof`.
/** Accepts a `Temporal.PlainDate` as a procedure input. */
export const PlainDate = z.instanceof(Temporal.PlainDate);
/** Accepts a `Temporal.Instant` as a procedure input. */
export const Instant = z.instanceof(Temporal.Instant);

/** Parses an ISO calendar date such as `2026-11-04` into a `Temporal.PlainDate`. */
export const PlainDateString = z.iso.date().transform((date) => Temporal.PlainDate.from(date));
