import { isSpanContextValid, trace } from "@opentelemetry/api";
import { pino, stdSerializers, type DestinationStream, type Logger } from "pino";
import type { LogLevel } from "./config.ts";

export type { Logger };

// Serializes the `cause` of a logged `error` as the cause's type, message, stack, and own properties.
const withCause = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "cause" in error && error.cause instanceof Error
    ? { ...error, cause: stdSerializers.errWithCause(error.cause) }
    : error;

/**
 * Creates the root logger. It writes JSON to stdout and records each level by name, so log queries
 * can filter on levels. A line written inside a span carries that span's `trace_id` and `span_id`,
 * which link the line to its trace.
 */
export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "airway" },
      formatters: { level: (label) => ({ level: label }) },
      // Without this serializer, pino writes an Error in the `cause` of a plain-object error as `{}`.
      serializers: { error: withCause },
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
