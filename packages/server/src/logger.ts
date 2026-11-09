import { isSpanContextValid, trace } from "@opentelemetry/api";
import { pino, type DestinationStream, type Logger } from "pino";
import type { LogLevel } from "./config.ts";

export type { Logger };

/**
 * The root logger: JSON on stdout, levels by name so Loki can filter on them. A line written
 * inside a span carries its `trace_id` and `span_id`, so Grafana can open the trace from the log.
 */
export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "airway" },
      formatters: { level: (label) => ({ level: label }) },
      mixin: () => {
        const span = trace.getActiveSpan()?.spanContext();

        return span !== undefined && isSpanContextValid(span)
          ? { trace_id: span.traceId, span_id: span.spanId }
          : {};
      },
    },
    destination,
  );
}
