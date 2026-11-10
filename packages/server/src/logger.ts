import { isSpanContextValid, trace } from "@opentelemetry/api";
import { pino, type DestinationStream, type Logger } from "pino";
import type { LogLevel } from "./config.ts";

export type { Logger };

/**
 * The root logger: JSON on stdout, with levels by name so log queries can filter on them. A line
 * written inside a span carries its `trace_id` and `span_id`, which link it to its trace.
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
