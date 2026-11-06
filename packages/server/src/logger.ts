import { pino, type Logger } from "pino";
import type { LogLevel } from "./config.ts";

export type { Logger };

/** The root logger: JSON on stdout, levels by name so Loki can filter on them. */
export function createLogger(level: LogLevel): Logger {
  return pino({
    level,
    base: { service: "airway" },
    formatters: { level: (label) => ({ level: label }) },
  });
}
