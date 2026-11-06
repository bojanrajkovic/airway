import { pino, type Logger } from "pino";
import type { LogLevel } from "./config.ts";

export type { Logger };

// A backstop: code logs ids, counts, and outcomes, never values. These paths catch the mistakes.
const REDACT = [
  "*.authorization",
  "*.cookie",
  "*.password",
  "*.birthDate",
  "*.databaseUrl",
  "*.readerDatabaseUrl",
  'req.headers["x-pomerium-jwt-assertion"]',
];

/** The root logger: JSON on stdout, levels by name so Loki can filter on them. */
export function createLogger(level: LogLevel): Logger {
  return pino({
    level,
    base: { service: "airway" },
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT, censor: "[redacted]" },
  });
}
