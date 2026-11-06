import { z } from "zod";

/** An ISO calendar date such as `2026-11-04`, parsed to a `Temporal.PlainDate`. */
export const PlainDateString = z.iso.date().transform((date) => Temporal.PlainDate.from(date));
