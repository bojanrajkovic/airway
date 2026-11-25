import { customType } from "drizzle-orm/pg-core";

// Drizzle's node-postgres driver sends its own type parsers with every query, and they return
// `timestamptz` and `date` as text. They override the pool's parsers, so the pool's Temporal
// conversion never runs for Drizzle queries. These columns convert the text themselves.

/** Reads and writes a `timestamptz` column as a `Temporal.Instant`. */
export const instant = customType<{ data: Temporal.Instant; driverData: string }>({
  dataType: () => "timestamp with time zone",
  toDriver: (value) => value.toString(),
  // Postgres sends text like `2030-01-01 02:00:00+00`, which `Temporal.Instant.from` parses directly.
  fromDriver: (value) => Temporal.Instant.from(value),
});

/** Reads and writes a `date` column as a `Temporal.PlainDate`. */
export const plainDate = customType<{ data: Temporal.PlainDate; driverData: string }>({
  dataType: () => "date",
  toDriver: (value) => value.toString(),
  fromDriver: (value) => Temporal.PlainDate.from(value),
});
