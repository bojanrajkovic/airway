import { pino, type DestinationStream, type Logger } from "pino";
import type { LogLevel } from "./config.ts";

export type { Logger };

// A backstop: code logs ids, counts, and outcomes, never values. These keys are redacted at the
// top level and up to three objects down, so logging a whole AppContext still hides them.
const SECRET_KEYS = [
  "authorization",
  "cookie",
  "password",
  "birthDate",
  "databaseUrl",
  "readerDatabaseUrl",
];
const REDACT = SECRET_KEYS.flatMap((key) =>
  ["", "*.", "*.*.", "*.*.*."].map((depth) => `${depth}${key}`),
);

/** The root logger: JSON on stdout, levels by name so Loki can filter on them. */
export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "airway" },
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT, censor: "[redacted]" },
    },
    destination,
  );
}
